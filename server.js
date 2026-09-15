const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");
const { computeSchedule, isValidDate, today } = require("./schedule");

const PORT = Number(process.env.PORT || 3020);
let DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

// 缺损类型默认标准工时(小时),可通过 POST /repair-types 增补或调整
const DEFAULT_REPAIR_TYPES = [
  { type: "虫蛀孔", standardHours: 1.5 },
  { type: "撕裂", standardHours: 3 },
  { type: "折痕", standardHours: 1 },
  { type: "水渍", standardHours: 2 },
  { type: "霉斑", standardHours: 2.5 },
  { type: "缺损", standardHours: 4 }
];

function freshInitialData() {
  const now = new Date().toISOString();
  return {
    rubbings: [
      {
        id: "rubbing_demo",
        code: "TP-清-014",
        source: "地方碑刻残页",
        paperSize: "42x68cm",
        note: "边缘有旧折痕",
        createdAt: now
      }
    ],
    damages: [
      {
        id: "damage_demo_1",
        rubbingId: "rubbing_demo",
        position: "左上角第3列题字旁",
        type: "虫蛀孔",
        beforePhotoUrl: "https://example.local/before-014-1.jpg",
        afterPhotoUrl: "",
        status: "pending",
        repairNote: "",
        batchId: null,
        createdAt: now,
        repairedAt: null
      },
      {
        id: "damage_demo_2",
        rubbingId: "rubbing_demo",
        position: "下边缘中央",
        type: "撕裂",
        beforePhotoUrl: "https://example.local/before-014-2.jpg",
        afterPhotoUrl: "",
        status: "pending",
        repairNote: "",
        batchId: null,
        createdAt: now,
        repairedAt: null
      }
    ],
    batches: [],
    workstations: [],
    repairTypes: DEFAULT_REPAIR_TYPES.map((t) => ({ ...t, updatedAt: now })),
    schedules: [],
    scheduleRequests: []
  };
}

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete",
  "GET /workstations",
  "POST /workstations",
  "PATCH /workstations/:id",
  "GET /repair-types",
  "POST /repair-types",
  "GET /schedule?workstationId=&date=&damageId=&batchId=&status=",
  "POST /schedule/plan",
  "POST /schedule/replan",
  "PATCH /schedule/:id"
];

// 老版本 db.json 缺字段时补齐,保证平滑迁移
function normalizeDb(db) {
  const now = new Date().toISOString();
  db.rubbings = Array.isArray(db.rubbings) ? db.rubbings : [];
  db.damages = Array.isArray(db.damages) ? db.damages : [];
  db.batches = Array.isArray(db.batches) ? db.batches : [];
  db.workstations = Array.isArray(db.workstations) ? db.workstations : [];
  db.repairTypes = Array.isArray(db.repairTypes) && db.repairTypes.length
    ? db.repairTypes
    : DEFAULT_REPAIR_TYPES.map((t) => ({ ...t, updatedAt: now }));
  db.schedules = Array.isArray(db.schedules) ? db.schedules : [];
  db.scheduleRequests = Array.isArray(db.scheduleRequests) ? db.scheduleRequests : [];
  db.batches.forEach((batch) => {
    if (typeof batch.urgency !== "number") batch.urgency = 3;
  });
  return db;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(freshInitialData(), null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return normalizeDb(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段:${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  return {
    ...batch,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

function enrichSchedule(db, entry) {
  const workstation = db.workstations.find((item) => item.id === entry.workstationId);
  const damage = db.damages.find((item) => item.id === entry.damageId);
  return {
    ...entry,
    workstationName: workstation ? workstation.name : null,
    damage: damage
      ? { id: damage.id, rubbingId: damage.rubbingId, position: damage.position, type: damage.type, status: damage.status }
      : null
  };
}

// ---------- 排期互斥锁:同一时刻只允许一个 plan/replan,其余立即 409 ----------
let planLockHeld = false;
function acquirePlanLock() {
  if (planLockHeld) return false;
  planLockHeld = true;
  return true;
}
function releasePlanLock() {
  planLockHeld = false;
}

// 待排池:已开工(进入未关闭批次、状态 in_repair)且当前没有有效排期记录的缺损项
function schedulableDamages(db, fixedDamageIds) {
  const openBatchIds = new Set(db.batches.filter((b) => b.status === "open").map((b) => b.id));
  return db.damages.filter(
    (d) => d.status === "in_repair" && openBatchIds.has(d.batchId) && !fixedDamageIds.has(d.id)
  );
}

async function handlePlan(req, res, kind) {
  const body = await parseBody(req);
  required(body, ["requestId"]);
  const requestId = String(body.requestId);
  const startDate = body.startDate || today();
  if (!isValidDate(startDate)) badRequest("startDate格式应为YYYY-MM-DD");

  // 先拿锁再读库:并发重排只放行一个,另一个直接 409 且不改数据
  if (!acquirePlanLock()) {
    return send(res, 409, { error: "已有排期请求正在处理,请稍后重试", conflict: true });
  }
  try {
    const db = await readDb();

    // 幂等:同一请求号只生效一次,重复提交返回首次结果
    const dup = db.scheduleRequests.find((r) => r.requestId === requestId);
    if (dup) {
      if (dup.kind !== kind) {
        return send(res, 409, { error: `请求号${requestId}已用于${dup.kind}操作,请更换请求号`, conflict: true });
      }
      return send(res, 200, { data: { ...dup.response, duplicated: true } });
    }

    const now = new Date().toISOString();
    let fixedEntries;
    let releasedCount = 0;
    if (kind === "replan") {
      // 重排:已锁定或已开工(含已完成)的记录不动,其余释放重排
      fixedEntries = db.schedules.filter((s) => s.locked || s.status !== "scheduled");
      const released = db.schedules.filter((s) => !s.locked && s.status === "scheduled");
      releasedCount = released.length;
      db.schedules = fixedEntries;
    } else {
      // 首次排期:已有记录一律不动,只排没有记录的项
      fixedEntries = db.schedules;
    }

    const fixedDamageIds = new Set(fixedEntries.map((s) => s.damageId));
    const candidates = schedulableDamages(db, fixedDamageIds);
    const result = computeSchedule(db, { startDate, candidates, fixedEntries });

    const damageMap = new Map(db.damages.map((d) => [d.id, d]));
    const wsMap = new Map(db.workstations.map((w) => [w.id, w]));
    const newEntries = result.assignments.map((a) => ({
      id: makeId("sch"),
      damageId: a.damageId,
      batchId: damageMap.get(a.damageId)?.batchId ?? null,
      workstationId: a.workstationId,
      date: a.date,
      hours: a.hours,
      status: "scheduled",
      locked: false,
      deferred: a.deferred,
      deferReason: a.deferReason,
      requestId,
      createdAt: now,
      updatedAt: now
    }));
    db.schedules.push(...newEntries);

    const response = {
      requestId,
      kind,
      startDate,
      generatedAt: now,
      releasedCount,
      assignments: newEntries.map((entry) => ({
        scheduleId: entry.id,
        damageId: entry.damageId,
        batchId: entry.batchId,
        workstationId: entry.workstationId,
        workstationName: wsMap.get(entry.workstationId)?.name ?? null,
        date: entry.date,
        hours: entry.hours,
        deferred: entry.deferred,
        deferReason: entry.deferReason
      })),
      unscheduled: result.unscheduled,
      duplicated: false
    };
    db.scheduleRequests.push({ requestId, kind, response, createdAt: now });
    await writeDb(db);
    return send(res, 200, { data: response });
  } finally {
    releasePlanLock();
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // 排期写操作单独走互斥锁,不参与下面的普通读库
  if (req.method === "POST" && pathname === "/schedule/plan") return handlePlan(req, res, "plan");
  if (req.method === "POST" && pathname === "/schedule/replan") return handlePlan(req, res, "replan");

  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const body = await parseBody(req);
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote
    });
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
    if (damage.status === "repaired") {
      db.schedules.forEach((s) => {
        if (s.damageId === damage.id && s.status !== "done") {
          s.status = "done";
          s.updatedAt = new Date().toISOString();
        }
      });
    }
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) return send(res, 400, { error: "damageIds必须是非空数组" });
    const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在:${invalid.join(", ")}` });
    const urgency = body.urgency === undefined ? 3 : Number(body.urgency);
    if (!Number.isFinite(urgency)) return send(res, 400, { error: "urgency必须是数字,越小越紧迫" });
    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      urgency,
      damageIds: body.damageIds,
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (body.damageIds.includes(damage.id)) {
        damage.batchId = batch.id;
        damage.status = "in_repair";
      }
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === completeMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    batch.note = body.note ?? batch.note;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = new Date().toISOString();
    });
    db.schedules.forEach((s) => {
      if (batch.damageIds.includes(s.damageId) && s.status !== "done") {
        s.status = "done";
        s.updatedAt = new Date().toISOString();
      }
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  // ---------- 工位 ----------
  if (req.method === "GET" && pathname === "/workstations") {
    return send(res, 200, { data: db.workstations });
  }

  if (req.method === "POST" && pathname === "/workstations") {
    const body = await parseBody(req);
    required(body, ["name", "dailyHours"]);
    const dailyHours = Number(body.dailyHours);
    if (!(dailyHours > 0)) return send(res, 400, { error: "dailyHours必须是正数" });
    const disabledDates = body.disabledDates || [];
    const disabledWeekdays = body.disabledWeekdays || [];
    if (!Array.isArray(disabledDates) || disabledDates.some((d) => !isValidDate(d))) {
      return send(res, 400, { error: "disabledDates必须是YYYY-MM-DD日期数组" });
    }
    if (!Array.isArray(disabledWeekdays) || disabledWeekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return send(res, 400, { error: "disabledWeekdays必须是0-6的整数数组(0=周日)" });
    }
    const workstation = {
      id: makeId("ws"),
      name: body.name,
      dailyHours,
      disabledDates,
      disabledWeekdays,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.workstations.push(workstation);
    await writeDb(db);
    return send(res, 201, { data: workstation });
  }

  const workstationMatch = pathname.match(/^\/workstations\/([^/]+)$/);
  if (workstationMatch && req.method === "PATCH") {
    const workstation = db.workstations.find((item) => item.id === workstationMatch[1]);
    if (!workstation) return send(res, 404, { error: "工位不存在" });
    const body = await parseBody(req);
    if (body.dailyHours !== undefined) {
      const dailyHours = Number(body.dailyHours);
      if (!(dailyHours > 0)) return send(res, 400, { error: "dailyHours必须是正数" });
      workstation.dailyHours = dailyHours;
    }
    if (body.disabledDates !== undefined) {
      if (!Array.isArray(body.disabledDates) || body.disabledDates.some((d) => !isValidDate(d))) {
        return send(res, 400, { error: "disabledDates必须是YYYY-MM-DD日期数组" });
      }
      workstation.disabledDates = body.disabledDates;
    }
    if (body.disabledWeekdays !== undefined) {
      if (!Array.isArray(body.disabledWeekdays) || body.disabledWeekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        return send(res, 400, { error: "disabledWeekdays必须是0-6的整数数组(0=周日)" });
      }
      workstation.disabledWeekdays = body.disabledWeekdays;
    }
    workstation.name = body.name ?? workstation.name;
    workstation.note = body.note ?? workstation.note;
    await writeDb(db);
    return send(res, 200, { data: workstation });
  }

  // ---------- 缺损类型标准工时 ----------
  if (req.method === "GET" && pathname === "/repair-types") {
    return send(res, 200, { data: db.repairTypes });
  }

  if (req.method === "POST" && pathname === "/repair-types") {
    const body = await parseBody(req);
    required(body, ["type", "standardHours"]);
    const standardHours = Number(body.standardHours);
    if (!(standardHours > 0)) return send(res, 400, { error: "standardHours必须是正数" });
    const existing = db.repairTypes.find((t) => t.type === body.type);
    if (existing) {
      existing.standardHours = standardHours;
      existing.updatedAt = new Date().toISOString();
    } else {
      db.repairTypes.push({ type: body.type, standardHours, updatedAt: new Date().toISOString() });
    }
    await writeDb(db);
    return send(res, 200, { data: db.repairTypes.find((t) => t.type === body.type) });
  }

  // ---------- 排期查询:按工位、日期、缺损项等过滤 ----------
  if (req.method === "GET" && pathname === "/schedule") {
    const workstationId = url.searchParams.get("workstationId");
    const date = url.searchParams.get("date");
    const damageId = url.searchParams.get("damageId");
    const batchId = url.searchParams.get("batchId");
    const status = url.searchParams.get("status");
    const data = db.schedules
      .filter((s) => !workstationId || s.workstationId === workstationId)
      .filter((s) => !date || s.date === date)
      .filter((s) => !damageId || s.damageId === damageId)
      .filter((s) => !batchId || s.batchId === batchId)
      .filter((s) => !status || s.status === status)
      .map((s) => enrichSchedule(db, s))
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
    return send(res, 200, { data });
  }

  // ---------- 排期记录:锁定/解锁、开工、完工 ----------
  const scheduleMatch = pathname.match(/^\/schedule\/([^/]+)$/);
  if (scheduleMatch && req.method === "PATCH") {
    const entry = db.schedules.find((item) => item.id === scheduleMatch[1]);
    if (!entry) return send(res, 404, { error: "排期记录不存在" });
    const body = await parseBody(req);
    if (body.locked !== undefined) {
      if (typeof body.locked !== "boolean") return send(res, 400, { error: "locked必须是布尔值" });
      entry.locked = body.locked;
    }
    if (body.status !== undefined) {
      const allowed = { scheduled: ["in_progress"], in_progress: ["done"], done: [] };
      if (!Object.keys(allowed).includes(body.status)) {
        return send(res, 400, { error: "status只能是scheduled/in_progress/done" });
      }
      if (!allowed[entry.status].includes(body.status)) {
        return send(res, 400, { error: `状态不能从${entry.status}变为${body.status}` });
      }
      entry.status = body.status;
    }
    entry.updatedAt = new Date().toISOString();
    await writeDb(db);
    return send(res, 200, { data: enrichSchedule(db, entry) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
  });
}

// 测试钩子:切换数据文件、重置数据
function setDbFile(file) {
  DB_FILE = file;
}
async function resetDb(data) {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  await writeDb(data ? normalizeDb(data) : freshInitialData());
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { createServer, setDbFile, resetDb, freshInitialData };
