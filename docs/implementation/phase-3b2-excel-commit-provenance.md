# 阶段三 B2：Excel 修正、单事务提交与字段来源保护

## 1. 本增量边界

本增量在 03B1 安全预检基础上，完成预检修正、确认提交、稳定去重、Jira 主事实保护和逐字段 provenance 后端闭环。它不包含页面导入向导；页面上传、筛选、单元格对照、修正表单、确认摘要与任务来源展示在 03B3 独立实现和验收。

## 2. 预检修正

- `PUT /api/v1/excel-imports/:id/resolutions` 同时要求 import version 和每个 row version，任一版本过期返回 412，整批修正不部分生效。
- 每行只能选择 `create_excel`、`link_jira` 或 `skip`。链接 Jira 时只能选择预检已列出的候选，且候选必须仍是 Jira 主任务。
- 支持修正父任务 ID/名称、标题、经办人、开始/到期日期和工时；服务端重新执行 issue key、严格日期、日期先后、标题、工时和身份别名校验。
- 公式无缓存、非法日期或非法工时只有在对应字段被明确修正后才能解除；修正其他字段不会静默清除原有 warning/info。
- `skip` 是显式用户决定，可跳过无法或无需导入的行；父任务容器只能跳过。修正只更新预检快照，不回写源 Excel。

## 3. 确认提交与幂等

- `POST /api/v1/excel-imports/:id/commit` 要求 `Idempotency-Key`、`previewVersion` 和 `acknowledgedWarnings`。
- 非 skip 行只要仍有 blocking/conflict 就拒绝提交；存在 warning 而用户未确认也拒绝。
- Task、来源观测、字段 provenance、逐行提交状态、导入状态、提交摘要和幂等响应在同一 SQLite 事务写入。任一后续行失败时，前面已处理的任务和来源也全部回滚。
- 幂等响应与业务数据同事务完成，避免“业务已提交但幂等记录永久 processing”。同一请求重放或已提交预检使用新幂等键再次确认，都返回原摘要且不重复任务、观测和来源。
- Excel 独立任务使用工作表名与规范化行指纹生成唯一 `sourceStableKey`；用户修正会重算指纹。重复文件、重复提交和重复稳定行均有数据库约束与服务端查询双重保护。

## 4. Jira 主、Excel 补充

合并字段限定为 `plannedStartDate`、`dueDate`、`originalEstimateSeconds`：

- Jira 字段非空：任务值保持 Jira，创建 active `keep_jira` provenance，Excel 候选只留在原因和行快照中。
- Jira 字段为空且 Excel 非空：本地统一任务采用 Excel 值，创建 active `supplement` provenance；系统不调用 Jira 写 API。
- Excel 独立任务的非空字段创建 active `source_fact` provenance；空工时不创建伪 0 来源，任务工时仍为 `null`。
- 数据库部分唯一索引保证同一任务同一字段最多一个 active provenance；替换时先结束旧来源并写 `supersededAt`，历史不删除。
- Jira 后续同步仍为空时保留 active Excel supplement；一旦 Jira 返回非空值，同一事务更新任务、结束 Excel 来源并建立 active Jira `source_fact`。Jira 同步重放不会重复生成相同 provenance。

任务详情接口现返回最近 100 条字段来源历史，包括字段、来源、决策、值、原因、生效/失效时间、来源观测和 Excel 行引用。

## 5. 数据模型与迁移

- `Task.sourceStableKey` 提供跨导入稳定唯一键；Jira 任务也在同步时补齐 `jira:<connection>:<issueKey>` 来源键。
- `ExcelImport.diagnosticsJson` 保存文件/工作表级诊断，`commitSummaryJson` 保存可重放提交摘要。
- `ExcelImportRow.committedTaskId` 与 `sourceObservationId` 增加真实外键，旧预检行在 SQLite 重建表迁移中完整复制。
- `task_field_provenance_one_active_field_key` 是带 `active = 1` 条件的唯一索引，允许保留任意数量的失效历史。

从全新 SQLite 数据库应用全部 7 个生产迁移后：迁移状态最新、Prisma schema diff 为零、`integrity_check=ok`、外键违规为 0，active provenance 部分唯一索引存在。

## 6. 自动化验证

新增/扩展集成测试覆盖：

- Jira 已有开始日期和工时不被 Excel 覆盖，Jira 空到期日被 Excel 补充；
- G 为空的 Excel 独立任务最终工时仍为 `null`；
- 已提交预检重复确认不增加 Task、TaskSourceObservation 或 TaskFieldProvenance；
- 第二行执行失败时第一行创建的任务及全部提交状态回滚；
- 冲突修正只能选择候选 Jira，import/row 旧版本均拒绝；warning 在修正其他字段后仍保留；
- 同一损坏文件重复上传继续返回原失败，不伪装为成功 replay；
- Jira 后续出现非空值时替代 Excel supplement，旧 provenance 结束且新 Jira provenance 生效。

全仓 `pnpm verify` 通过：格式、lint、类型检查、106 项测试和生产构建全部成功。其中 API 22 个测试文件共 87 项全部通过。

## 7. 后续验收门

03B3 必须实现完整导入向导：上传与历史、工作表/列识别、按严重度/工作表/动作筛选、原值/规范化值/单元格坐标、候选选择、逐行修正、warning 确认、提交摘要、任务字段来源历史。完成浏览器真实交互和源文件哈希前后对账后，才能把 `AC-XLS-03`、`AC-XLS-04` 提升为 verified。
