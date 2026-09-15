// 排期引擎:纯函数,不做任何 IO,便于单测。
// 输入:工位、缺损项、批次、类型工时表、已固定(锁定/已开工)的排期记录。
// 输出:新排期结果 + 无法排期项(带原因,不丢项)。

const HORIZON_DAYS = 180; // 顺延搜索窗口:自起始日起最多向后找 180 天
const EPS = 1e-9;

function isValidDate(dateStr) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateStr;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

// 工位在某天是否停用:命中具体停用日期或按星期停用
function isDisabled(workstation, dateStr) {
  if (Array.isArray(workstation.disabledDates) && workstation.disabledDates.includes(dateStr)) return true;
  if (Array.isArray(workstation.disabledWeekdays) && workstation.disabledWeekdays.includes(weekdayOf(dateStr))) return true;
  return false;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// 排序:批次紧迫度(数字小者优先) → 批次登记序号 → 缺损项登记序号。
// seq 是持久化的自增登记序号,同毫秒登记也有稳定先后,重复排期结果一致。
function sortCandidates(db, candidates) {
  const batchMap = new Map(db.batches.map((b) => [b.id, b]));
  const batchOf = (d) => batchMap.get(d.batchId) || {};
  return [...candidates].sort((a, b) => {
    const ba = batchOf(a);
    const bb = batchOf(b);
    const ua = ba.urgency ?? 3;
    const ub = bb.urgency ?? 3;
    if (ua !== ub) return ua - ub;
    const batchSeq = (ba.seq ?? 0) - (bb.seq ?? 0);
    if (batchSeq !== 0) return batchSeq;
    const damageSeq = (a.seq ?? 0) - (b.seq ?? 0);
    if (damageSeq !== 0) return damageSeq;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1; // 兜底,正常不会走到
    return 0;
  });
}

// 工位挑选顺序:按登记序号,同毫秒登记也稳定
function bySeq(a, b) {
  const d = (a.seq ?? 0) - (b.seq ?? 0);
  if (d !== 0) return d;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

// 校验不动项(锁定/已开工/已完成)在起始日及之后是否冲破工位当前日上限。
// 返回违规列表:[{ workstationId, workstationName, date, usedHours, dailyHours, entryIds }]
function findLimitViolations(db, entries, startDate) {
  const wsMap = new Map(db.workstations.map((w) => [w.id, w]));
  const usage = new Map(); // workstationId|date -> { used, entryIds }
  for (const entry of entries) {
    if (startDate && entry.date < startDate) continue; // 历史日计划不在本次排期范围
    const key = `${entry.workstationId}|${entry.date}`;
    if (!usage.has(key)) usage.set(key, { workstationId: entry.workstationId, date: entry.date, used: 0, entryIds: [] });
    const u = usage.get(key);
    u.used = round4(u.used + entry.hours);
    u.entryIds.push(entry.id);
  }
  const violations = [];
  for (const u of usage.values()) {
    const ws = wsMap.get(u.workstationId);
    if (!ws) continue;
    if (u.used > ws.dailyHours + EPS) {
      violations.push({
        workstationId: u.workstationId,
        workstationName: ws.name,
        date: u.date,
        usedHours: u.used,
        dailyHours: ws.dailyHours,
        entryIds: u.entryIds
      });
    }
  }
  return violations.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 计算排期。
 * @param {object} db 数据库快照
 * @param {string} startDate 起始日 YYYY-MM-DD(含)
 * @param {Array} candidates 待排缺损项(调用方负责筛选)
 * @param {Array} fixedEntries 不动项(锁定/已开工/已完成),仍占用当日工时
 * @returns {{assignments: Array, unscheduled: Array}}
 *   assignments: { damageId, workstationId, date, hours, deferred, deferReason }
 *   unscheduled: { damageId, reason }  排不下的项保留在此,不丢项
 */
function computeSchedule(db, { startDate, candidates, fixedEntries }) {
  const workstations = [...db.workstations].sort(bySeq);
  const typeHours = new Map(db.repairTypes.map((t) => [t.type, t.standardHours]));

  // 已固定记录占用的工时:workstationId|date -> 已用小时
  const usage = new Map();
  for (const entry of fixedEntries) {
    const key = `${entry.workstationId}|${entry.date}`;
    usage.set(key, round4((usage.get(key) || 0) + entry.hours));
  }

  const assignments = [];
  const unscheduled = [];
  const maxDaily = workstations.reduce((m, w) => Math.max(m, w.dailyHours), 0);

  for (const damage of sortCandidates(db, candidates)) {
    const hours = typeHours.get(damage.type);
    if (hours === undefined) {
      unscheduled.push({ damageId: damage.id, reason: `缺损类型「${damage.type}」未登记标准工时,请先在 /repair-types 登记` });
      continue;
    }
    if (!(hours > 0)) {
      unscheduled.push({ damageId: damage.id, reason: `缺损类型「${damage.type}」标准工时(${hours})无效,必须为正数` });
      continue;
    }
    if (workstations.length === 0) {
      unscheduled.push({ damageId: damage.id, reason: "尚未登记任何工位,无法排期" });
      continue;
    }
    if (hours > maxDaily + EPS) {
      unscheduled.push({
        damageId: damage.id,
        reason: `标准工时${hours}h超过所有工位日工时上限(最大${maxDaily}h),单项不拆分,无法排期`
      });
      continue;
    }

    // 自起始日逐天找第一个能容纳整项的工位(按工位登记顺序),不拆到两天
    const skipped = [];
    let placed = null;
    for (let offset = 0; offset <= HORIZON_DAYS && !placed; offset++) {
      const date = addDays(startDate, offset);
      const causes = [];
      for (const ws of workstations) {
        if (isDisabled(ws, date)) {
          causes.push(`工位「${ws.name}」停用`);
          continue;
        }
        const used = usage.get(`${ws.id}|${date}`) || 0;
        const remain = round4(ws.dailyHours - used);
        if (remain + EPS < hours) {
          causes.push(`工位「${ws.name}」剩余${remain}h不足${hours}h`);
          continue;
        }
        placed = { workstation: ws, date };
        break;
      }
      if (!placed) skipped.push(`${date}:${causes.join(",") || "无可用工位"}`);
    }

    if (!placed) {
      unscheduled.push({
        damageId: damage.id,
        reason: `自${startDate}起${HORIZON_DAYS}天内无可用工位(首日:${skipped[0] || "无"}),待人工处理`
      });
      continue;
    }

    const key = `${placed.workstation.id}|${placed.date}`;
    usage.set(key, round4((usage.get(key) || 0) + hours));
    const deferred = skipped.length > 0;
    assignments.push({
      damageId: damage.id,
      workstationId: placed.workstation.id,
      date: placed.date,
      hours,
      deferred,
      deferReason: deferred
        ? `未能在${startDate}排入,顺延至${placed.date}:${skipped.slice(0, 5).join(";")}${skipped.length > 5 ? `;等共${skipped.length}天不可用` : ""}`
        : ""
    });
  }

  return { assignments, unscheduled };
}

module.exports = {
  HORIZON_DAYS,
  isValidDate,
  today,
  addDays,
  weekdayOf,
  isDisabled,
  sortCandidates,
  findLimitViolations,
  computeSchedule
};
