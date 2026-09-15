const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createServer, setDbFile, resetDb } = require("../server");

// 每个用例独立数据文件 + 独立服务实例,互不影响
async function boot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rubbing-sched-"));
  setDbFile(path.join(dir, "db.json"));
  await resetDb();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  };
  return { base, api };
}

// 便捷操作:建工位 / 建缺损项 / 开批次
async function addWorkstation(api, over = {}) {
  const res = await api("POST", "/workstations", { name: "工位A", dailyHours: 8, ...over });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function addDamage(api, type, over = {}) {
  const res = await api("POST", "/rubbings/rubbing_demo/damages", {
    position: "测试部位",
    type,
    beforePhotoUrl: "https://example.local/b.jpg",
    ...over
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function openBatch(api, damageIds, over = {}) {
  const res = await api("POST", "/batches", { name: "测试批次", damageIds, ...over });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function scheduleOf(api, damageId) {
  const res = await api("GET", `/schedule?damageId=${damageId}`);
  assert.equal(res.status, 200);
  return res.body.data;
}

test("工时上限:同工位当日总工时不超上限,放不下的整项顺延到次日(不拆两天)", async (t) => {
  const { api } = await boot(t);
  const ws = await addWorkstation(api, { dailyHours: 4 });
  // 撕裂标准工时 3h,两项共 6h,同一天放不下
  const d1 = await addDamage(api, "撕裂");
  const d2 = await addDamage(api, "撕裂");
  await openBatch(api, [d1.id, d2.id]);

  const plan = await api("POST", "/schedule/plan", { requestId: "req-cap-1", startDate: "2026-09-15" });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const { assignments, unscheduled } = plan.body.data;
  assert.equal(assignments.length, 2, "两项都应排上,不丢项");
  assert.equal(unscheduled.length, 0);

  const dates = assignments.map((a) => a.date).sort();
  assert.deepEqual(dates, ["2026-09-15", "2026-09-16"], "一项当天,另一项顺延次日");

  // 当日总工时不得超过上限
  const day1 = await api("GET", `/schedule?workstationId=${ws.id}&date=2026-09-15`);
  const used = day1.body.data.reduce((sum, s) => sum + s.hours, 0);
  assert.ok(used <= 4, `当日工时${used}应≤4`);

  // 顺延项必须带原因
  const deferred = assignments.find((a) => a.date === "2026-09-16");
  assert.equal(deferred.deferred, true);
  assert.match(deferred.deferReason, /2026-09-15/);
  assert.match(deferred.deferReason, /不足/);
});

test("单项工时超过所有工位上限:不拆分、不丢项,进入unscheduled并说明原因", async (t) => {
  const { api } = await boot(t);
  await addWorkstation(api, { dailyHours: 4 });
  await api("POST", "/repair-types", { type: "整幅揭裱", standardHours: 6 });
  const d = await addDamage(api, "整幅揭裱");
  await openBatch(api, [d.id]);

  const plan = await api("POST", "/schedule/plan", { requestId: "req-big-1", startDate: "2026-09-15" });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.data.assignments.length, 0);
  assert.equal(plan.body.data.unscheduled.length, 1);
  assert.match(plan.body.data.unscheduled[0].reason, /不拆分|无法排期/);

  // 不丢项:再次排期时它仍在待排池里
  const again = await api("POST", "/schedule/plan", { requestId: "req-big-2", startDate: "2026-09-15" });
  assert.equal(again.body.data.unscheduled.length, 1);
  assert.equal(again.body.data.unscheduled[0].damageId, d.id);
});

test("停用日:具体停用日期和按星期停用都跳过,顺延到最近可用日", async (t) => {
  const { api } = await boot(t);
  const weekdayOf17 = new Date("2026-09-17T00:00:00Z").getUTCDay();
  const ws = await addWorkstation(api, {
    dailyHours: 3,
    disabledDates: ["2026-09-16"],
    disabledWeekdays: [weekdayOf17]
  });
  const d1 = await addDamage(api, "撕裂"); // 3h,占满 09-15
  const d2 = await addDamage(api, "撕裂"); // 只能顺延
  await openBatch(api, [d1.id, d2.id]);

  const plan = await api("POST", "/schedule/plan", { requestId: "req-off-1", startDate: "2026-09-15" });
  assert.equal(plan.status, 200);
  const e1 = (await scheduleOf(api, d1.id))[0];
  const e2 = (await scheduleOf(api, d2.id))[0];
  assert.equal(e1.date, "2026-09-15");
  assert.equal(e2.date, "2026-09-18", "16日停用、17日按星期停用,应顺延到18日");
  assert.equal(e2.deferred, true);
  assert.match(e2.deferReason, /停用/);

  // 停用日绝不能有排期
  const on16 = await api("GET", `/schedule?workstationId=${ws.id}&date=2026-09-16`);
  const on17 = await api("GET", `/schedule?workstationId=${ws.id}&date=2026-09-17`);
  assert.equal(on16.body.data.length, 0);
  assert.equal(on17.body.data.length, 0);
});

test("锁定与已开工:重排只动未锁定项,锁定和已开工记录保持不动", async (t) => {
  const { api } = await boot(t);
  const ws = await addWorkstation(api, { dailyHours: 4 });
  await api("POST", "/repair-types", { type: "补纸", standardHours: 1 });
  const d1 = await addDamage(api, "撕裂"); // 3h
  const d2 = await addDamage(api, "补纸"); // 1h
  const d3 = await addDamage(api, "补纸"); // 1h
  await openBatch(api, [d1.id, d2.id]);
  await openBatch(api, [d3.id]);

  const plan = await api("POST", "/schedule/plan", { requestId: "req-lock-1", startDate: "2026-09-15" });
  assert.equal(plan.status, 200);
  // 15日:d1(3h)+d2(1h)=4h 刚好排满;d3 顺延到16日
  let e1 = (await scheduleOf(api, d1.id))[0];
  let e2 = (await scheduleOf(api, d2.id))[0];
  let e3 = (await scheduleOf(api, d3.id))[0];
  assert.equal(e1.date, "2026-09-15");
  assert.equal(e2.date, "2026-09-15");
  assert.equal(e3.date, "2026-09-16");

  // 锁定 d1,d3 开工
  await api("PATCH", `/schedule/${e1.id}`, { locked: true });
  const started = await api("PATCH", `/schedule/${e3.id}`, { status: "in_progress" });
  assert.equal(started.status, 200);

  // 工位日上限从 4h 调成 3h,再重排:未锁定的 d2 必须让位
  await api("PATCH", `/workstations/${ws.id}`, { dailyHours: 3 });
  const replan = await api("POST", "/schedule/replan", { requestId: "req-lock-2", startDate: "2026-09-15" });
  assert.equal(replan.status, 200, JSON.stringify(replan.body));
  assert.equal(replan.body.data.releasedCount, 1, "只有 d2 一条未锁定记录被释放重排");

  const after1 = (await scheduleOf(api, d1.id))[0];
  const after2 = (await scheduleOf(api, d2.id))[0];
  const after3 = (await scheduleOf(api, d3.id))[0];
  assert.equal(after1.id, e1.id, "锁定项记录不变");
  assert.equal(after1.date, "2026-09-15");
  assert.equal(after1.locked, true);
  assert.equal(after3.id, e3.id, "已开工项记录不变");
  assert.equal(after3.date, "2026-09-16");
  assert.equal(after3.status, "in_progress");
  // d2 被重排:15日已被锁定的 d1 占满 3h,只能去16日(16日有 d3 占 1h,余 2h 放得下)
  assert.equal(after2.date, "2026-09-16");
  // 两天都不超新上限 3h
  for (const date of ["2026-09-15", "2026-09-16"]) {
    const day = await api("GET", `/schedule?workstationId=${ws.id}&date=${date}`);
    const used = day.body.data.reduce((sum, s) => sum + s.hours, 0);
    assert.ok(used <= 3, `${date}当日工时${used}应≤3`);
  }
});

test("紧迫度排序:批次紧迫度高的先排,同级按登记先后和编号", async (t) => {
  const { api } = await boot(t);
  await addWorkstation(api, { dailyHours: 3 });
  // 先登记低优先级批次,后登记高优先级批次
  const low1 = await addDamage(api, "撕裂");
  const low2 = await addDamage(api, "撕裂");
  await openBatch(api, [low1.id, low2.id], { name: "普通批", urgency: 5 });
  const urgent = await addDamage(api, "撕裂");
  await openBatch(api, [urgent.id], { name: "加急批", urgency: 1 });

  const plan = await api("POST", "/schedule/plan", { requestId: "req-urg-1", startDate: "2026-09-15" });
  assert.equal(plan.status, 200);
  const eu = (await scheduleOf(api, urgent.id))[0];
  const el1 = (await scheduleOf(api, low1.id))[0];
  const el2 = (await scheduleOf(api, low2.id))[0];
  assert.equal(eu.date, "2026-09-15", "加急批虽然登记晚,但紧迫度高,应先排");
  // 同级按登记先后:low1 先于 low2
  assert.equal(el1.date, "2026-09-16");
  assert.equal(el2.date, "2026-09-17");
});

test("重复提交:同一请求号只生效一次,返回首次结果且不重复排期", async (t) => {
  const { api } = await boot(t);
  await addWorkstation(api, { dailyHours: 8 });
  const d1 = await addDamage(api, "撕裂");
  const d2 = await addDamage(api, "虫蛀孔");
  await openBatch(api, [d1.id, d2.id]);

  const first = await api("POST", "/schedule/plan", { requestId: "req-dup-1", startDate: "2026-09-15" });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.duplicated, false);
  assert.equal(first.body.data.assignments.length, 2);

  const second = await api("POST", "/schedule/plan", { requestId: "req-dup-1", startDate: "2026-09-15" });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.duplicated, true, "重复提交应标记duplicated");
  assert.deepEqual(
    second.body.data.assignments.map((a) => a.scheduleId).sort(),
    first.body.data.assignments.map((a) => a.scheduleId).sort(),
    "返回的是首次的结果"
  );

  // 数据没有翻倍
  const all = await api("GET", "/schedule");
  assert.equal(all.body.data.length, 2);

  // 同一请求号换操作类型 → 冲突
  const cross = await api("POST", "/schedule/replan", { requestId: "req-dup-1", startDate: "2026-09-15" });
  assert.equal(cross.status, 409);

  // 新请求号再 plan:所有项都已有排期,自然幂等,不重复
  const third = await api("POST", "/schedule/plan", { requestId: "req-dup-2", startDate: "2026-09-15" });
  assert.equal(third.body.data.assignments.length, 0);
  const all2 = await api("GET", "/schedule");
  assert.equal(all2.body.data.length, 2);
});

test("并发冲突:两个重排请求并发只成功一个,另一个409且不改数据", async (t) => {
  const { api } = await boot(t);
  await addWorkstation(api, { dailyHours: 8 });
  const d1 = await addDamage(api, "撕裂");
  const d2 = await addDamage(api, "水渍");
  const d3 = await addDamage(api, "虫蛀孔");
  await openBatch(api, [d1.id, d2.id, d3.id]);

  const plan = await api("POST", "/schedule/plan", { requestId: "req-conc-0", startDate: "2026-09-15" });
  assert.equal(plan.status, 200);
  const before = await api("GET", "/schedule");

  // 同时发两个重排
  const [r1, r2] = await Promise.all([
    api("POST", "/schedule/replan", { requestId: "req-conc-1", startDate: "2026-09-15" }),
    api("POST", "/schedule/replan", { requestId: "req-conc-2", startDate: "2026-09-15" })
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], `应一个成功一个冲突,实际${statuses}`);

  const loser = r1.status === 409 ? r1 : r2;
  assert.equal(loser.body.conflict, true);

  // 数据一致:每个缺损项恰好一条排期,没有重复也没有丢失
  const after = await api("GET", "/schedule");
  assert.equal(after.body.data.length, before.body.data.length, "总数不变,没有重复排期");
  const damageIds = after.body.data.map((s) => s.damageId).sort();
  assert.deepEqual(damageIds, [d1.id, d2.id, d3.id].sort());

  // 锁已释放,后续重排可正常进行
  const r3 = await api("POST", "/schedule/replan", { requestId: "req-conc-3", startDate: "2026-09-15" });
  assert.equal(r3.status, 200);
});

test("排期查询:按工位、日期、缺损项过滤", async (t) => {
  const { api } = await boot(t);
  const wsA = await addWorkstation(api, { name: "甲位", dailyHours: 3 });
  const wsB = await addWorkstation(api, { name: "乙位", dailyHours: 3 });
  const d1 = await addDamage(api, "撕裂");
  const d2 = await addDamage(api, "撕裂");
  await openBatch(api, [d1.id, d2.id]);
  const plan = await api("POST", "/schedule/plan", { requestId: "req-q-1", startDate: "2026-09-15" });
  assert.equal(plan.status, 200);
  // 两项 3h:甲位当天只能放一项,另一项由乙位或次日承接
  const all = await api("GET", "/schedule");
  assert.equal(all.body.data.length, 2);

  const byWs = await api("GET", `/schedule?workstationId=${wsA.id}`);
  assert.ok(byWs.body.data.every((s) => s.workstationId === wsA.id));
  assert.ok(byWs.body.data.length >= 1);

  const byDate = await api("GET", "/schedule?date=2026-09-15");
  assert.ok(byDate.body.data.every((s) => s.date === "2026-09-15"));

  const byDamage = await api("GET", `/schedule?damageId=${d1.id}`);
  assert.equal(byDamage.body.data.length, 1);
  assert.equal(byDamage.body.data[0].damageId, d1.id);
  assert.ok(byDamage.body.data[0].workstationName, "查询结果应带工位名称");

  // 组合过滤:工位+日期
  const combo = await api("GET", `/schedule?workstationId=${wsB.id}&date=2026-09-15`);
  assert.ok(combo.body.data.every((s) => s.workstationId === wsB.id && s.date === "2026-09-15"));
});

test("未登记类型不丢项:进unscheduled并提示登记标准工时", async (t) => {
  const { api } = await boot(t);
  await addWorkstation(api, { dailyHours: 8 });
  const d = await addDamage(api, "未知新类型");
  await openBatch(api, [d.id]);
  const plan = await api("POST", "/schedule/plan", { requestId: "req-unk-1", startDate: "2026-09-15" });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.data.unscheduled.length, 1);
  assert.match(plan.body.data.unscheduled[0].reason, /未登记标准工时/);

  // 登记类型后重排即可排上
  await api("POST", "/repair-types", { type: "未知新类型", standardHours: 2 });
  const replan = await api("POST", "/schedule/replan", { requestId: "req-unk-2", startDate: "2026-09-15" });
  assert.equal(replan.body.data.assignments.length, 1);
  assert.equal(replan.body.data.unscheduled.length, 0);
});
