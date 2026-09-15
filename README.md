# 古籍拓片缺损修补API

纯后端零依赖Node服务,使用 `data/db.json` 持久化拓片、缺损项、修补批次、工位和排期。

## 启动

```bash
PORT=3020 node server.js   # 或 npm start
```

## 测试

```bash
npm test                   # 等价于 node --test
```

测试覆盖:工时上限、单项不拆分、停用日(具体日期+按星期)、锁定/已开工不动、顺延及原因、
并发重排冲突、请求号重复提交、排期查询过滤、未登记类型不丢项、同毫秒登记排序稳定、
日上限调低后锁定项超限返回409且不落库。

## 排期规则

1. **待排池**:缺损项进入未关闭批次后(状态 `in_repair`,即"开工")进入待排池。
2. **标准工时**:按缺损类型定工时,见 `GET /repair-types`,未登记类型的项不丢,进 `unscheduled` 并提示。
3. **排序**:批次紧迫度 `urgency`(数字小者优先,默认3) → 批次登记序号 → 缺损项登记序号。
   登记序号 `seq` 是持久化自增序号,同一毫秒登记也有稳定先后,重复排期结果完全一致。
4. **放置**:每项整体排到某工位某一天,**不拆到两天**;同工位当日总工时不超过 `dailyHours`;停用日不排。
5. **顺延**:当天排不下则顺延到最近可用日,记录 `deferred=true` 和 `deferReason`(说明哪些天为何不可用);永远排不下的项进 `unscheduled` 带原因,不丢项。
6. **重排**:`/schedule/replan` 只释放未锁定且未开工的记录;**已锁定(`locked=true`)或已开工(`in_progress`/`done`)的记录不动**,仍占用当日工时。
7. **超限冲突**:若已锁定/已开工记录在起始日及之后的当日工时合计超过工位**当前**日上限
   (常见于日上限被调低后),`plan`/`replan` 返回 `409` 并在 `violations` 中列出超限的工位、日期、
   已用工时和涉及记录,**不落库任何超上限日计划**;失败的请求不消耗请求号,补救后可原号重试。
8. **幂等**:`plan`/`replan` 必须带 `requestId`,同一请求号只生效一次,重复提交返回首次结果(`duplicated=true`);请求号跨操作类型复用返回 409。
9. **并发**:同一时刻只允许一个排期写操作,并发请求直接返回 `409 {conflict:true}`,不改数据。

## 接口一览

### 基础

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`
- `GET /damages?status=&type=` / `PATCH /damages/:id`
- `GET /batches` / `POST /batches`(新增可选字段 `urgency`,数字越小越紧迫,默认3)
- `GET /batches/:id` / `POST /batches/:id/complete`(完工后相关排期记录自动置为 `done`)

### 工位

- `GET /workstations`
- `POST /workstations` — 登记工位

  ```json
  {
    "name": "甲位",
    "dailyHours": 8,
    "disabledDates": ["2026-10-01"],
    "disabledWeekdays": [0]
  }
  ```

  `dailyHours` 日工时上限(正数,必填);`disabledDates` 具体停用日(YYYY-MM-DD);
  `disabledWeekdays` 按星期停用(0=周日 … 6=周六)。后两者可选,默认空。

- `PATCH /workstations/:id` — 修改名称/上限/停用日

### 缺损类型标准工时

- `GET /repair-types`
- `POST /repair-types` — 登记或调整:`{"type":"撕裂","standardHours":3}`(同类型覆盖)

### 排期

- `POST /schedule/plan` — 首次排期:只排没有排期记录的待排项,已有记录不动

  ```json
  { "requestId": "plan-20260915-01", "startDate": "2026-09-15" }
  ```

- `POST /schedule/replan` — 重排:释放未锁定未开工记录后整体重排,锁定/已开工不动

  入参同 `plan`。两者响应结构一致:

  ```json
  {
    "data": {
      "requestId": "plan-20260915-01",
      "kind": "plan",
      "startDate": "2026-09-15",
      "releasedCount": 0,
      "assignments": [
        {
          "scheduleId": "sch_…",
          "damageId": "damage_…",
          "workstationId": "ws_…",
          "workstationName": "甲位",
          "date": "2026-09-16",
          "hours": 3,
          "deferred": true,
          "deferReason": "未能在2026-09-15排入,顺延至2026-09-16:2026-09-15:工位「甲位」剩余1h不足3h"
        }
      ],
      "unscheduled": [{ "damageId": "damage_…", "reason": "…" }],
      "duplicated": false
    }
  }
  ```

- `GET /schedule?workstationId=&date=&damageId=&batchId=&status=` — 按工位/日期/缺损项等组合查询
- `PATCH /schedule/:id` — 锁定/解锁 `{"locked":true}`;开工 `{"status":"in_progress"}`;完工 `{"status":"done"}`
  (状态只能 `scheduled → in_progress → done` 单向流转)

## 闭环示例

```bash
# 1. 登记工位(日上限4h,每周日停用)
curl -X POST http://127.0.0.1:3020/workstations \
  -H 'Content-Type: application/json' \
  -d '{"name":"甲位","dailyHours":4,"disabledWeekdays":[0]}'

# 2. 看哪些缺损项待修,开批次(urgency越小越紧迫)
curl 'http://127.0.0.1:3020/damages?status=pending'
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"九月加急批","urgency":1,"damageIds":["damage_demo_1","damage_demo_2"]}'

# 3. 排期(请求号幂等,重复提交只生效一次)
curl -X POST http://127.0.0.1:3020/schedule/plan \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"plan-20260915-01","startDate":"2026-09-15"}'

# 4. 按工位+日期查当日安排
curl 'http://127.0.0.1:3020/schedule?workstationId=<wsId>&date=2026-09-15'

# 5. 锁定重要项后重排(锁定项不动,其余重排)
curl -X PATCH http://127.0.0.1:3020/schedule/<scheduleId> \
  -H 'Content-Type: application/json' -d '{"locked":true}'
curl -X POST http://127.0.0.1:3020/schedule/replan \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"replan-20260915-01","startDate":"2026-09-15"}'
```

## 错误码

- `400` 参数缺失或非法(如 `dailyHours` 非正数、日期格式错误)
- `404` 资源不存在 / 接口不存在
- `409` 排期冲突(`conflict:true`):并发排期、请求号被其他操作占用,或锁定/已开工记录超过工位当前日上限(响应带 `violations` 明细)
