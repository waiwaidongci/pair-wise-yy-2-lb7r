# 赛鸽登记站 · 药检样本封存与结果冻结台

运行：

```bash
npm start
```

访问`http://localhost:3024`。支持档案、血统查询、转让、归巢成绩记录，以及药检样本封存、结论判定与成绩冻结。

## 业务文件

- `src/intake.js`（入口）：采样登记与资料补齐。采样绑定足环、时刻、封存号和采样人；封存号在未解封样本中唯一，重复或并发登记沿用首次结果返回 409；样本、送检单、鸽主确认缺一项只能留检。
- `src/adjudication.js`（判定）：初判、复检、更正。阳性后该鸽及三代内后代未结算成绩冻结，已结算名次保留；复检须换人并引用原封存号，相反结论待仲裁；更正按新结论重算，旧快照可查。
- `src/store.js`（存储）：持久化、旧数据迁移、写入串行化（并发安全）。

## 样本状态机

`留检 held →（补齐三项）→ 已封存 sealed →（判定）→ 阳性 judged / 阴性 released（解封，封存号释放）→（复检相反）→ 待仲裁 arbitration →（更正）→ judged / released`

## API

- `POST /api/lab/samples` 采样登记：`{ sealNo, ringNo, sampler, sampledAt?, hasSample?, hasManifest?, ownerConfirmed? }`
- `GET /api/lab/samples` / `GET /api/lab/samples/:id或封存号`
- `POST /api/lab/samples/:key/complete` 留检补齐资料
- `POST /api/lab/samples/:key/judge` 初判：`{ tester, verdict: "positive"|"negative" }`
- `POST /api/lab/samples/:key/retest` 复检：`{ tester, verdict, originalSealNo }`（须换人）
- `POST /api/lab/samples/:key/correct` 更正：`{ tester, verdict, reason? }`（留存旧快照后重算）
- `GET /api/lab/samples/:key/history` 旧快照查询
- `GET /api/lab/freezes` 冻结清单
- `POST /api/pigeons/:ring/races/:index/settle` 成绩结算（已冻结的不可结算）
