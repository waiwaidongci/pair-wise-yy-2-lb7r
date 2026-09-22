# 赛鸽药检样本封存与结果冻结台

在血统环号登记站基础上扩展药检业务，按职责拆为三个业务文件：

- `server.js` —— **入口**：HTTP 路由与页面，只做参数解析和结果返回
- `src/adjudication.js` —— **判定**：样本生命周期、阳性冻结、复检仲裁、更正重算的全部规则
- `src/store.js` —— **存储**：数据文件读写、旧库迁移、串行化写入（并发登记同一封存号时后者必见首次结果）

运行：

```bash
npm start
```

访问 `http://localhost:3024`。

## 业务规则

- **采样登记**：绑定足环号、采样时刻、封存号、采样人。封存号在**未解封**样本中唯一，重复或并发登记返回 `409` 并在响应中附带首次登记结果（`first` 字段）。
- **留检**：样本、送检单、鸽主确认缺任意一项只能留检（`held`），补齐后转封存待检（`sealed`），留检样本不得解封、不得判定。
- **冻结**：判定阳性后，本鸽及三代内后代（子、孙、曾孙）的**未结算**成绩冻结；已结算名次保留。冻结中的成绩不得结算，冻结期间新录成绩同样冻结。
- **复检**：须换人（复检人 ≠ 初检人）并引用原封存号；结论一致则确认，相反则**待仲裁**，仲裁前维持初检结论效力。
- **仲裁/更正**：仲裁给出终局结论；更正按新结论**重算**冻结。两者都会先把旧结论与旧冻结状态存入快照，旧快照可随时查询。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/samples` | 采样登记（`ringNo`/`sealNo`/`sampler`/`hasSample`/`hasSubmissionForm`/`hasOwnerConfirm`） |
| GET | `/api/samples` | 样本列表，可按 `?status=held|sealed|unsealed` 过滤 |
| GET | `/api/samples/:sealNo` | 样本详情（含复检、更正、履历） |
| POST | `/api/samples/:sealNo/materials` | 留检样本补齐材料（`all:true` 一键补齐） |
| POST | `/api/samples/:sealNo/unseal` | 实验室解封 |
| POST | `/api/samples/:sealNo/conclusion` | 初检判定（`analyst` + `conclusion: positive|negative`） |
| POST | `/api/samples/:sealNo/retest` | 复检（换人，引用原封存号） |
| POST | `/api/samples/:sealNo/arbitrate` | 仲裁（仅待仲裁样本） |
| POST | `/api/samples/:sealNo/correct` | 更正结论（须填原因，按新结论重算） |
| GET | `/api/freezes` | 当前冻结足环、冻结成绩与变动日志 |
| GET | `/api/snapshots` / `/api/snapshots/:id` | 快照列表 / 快照详情 |
| POST | `/api/pigeons/:ringNo/races/:index/settle` | 成绩结算（冻结中返回 `409`） |

鸽只档案、血统查询、转让、疫苗等登记站原有接口保持不变。
