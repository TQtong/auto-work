# 阶段三 A：Jira 防漏同步与任务主事实实现

## 1. 完整实现范围

- 新增 `Task`、`TaskStatusEvent`、`TaskSourceObservation`、`SyncCursor`、`JiraSyncRun` 持久化模型，并把任务、连接、映射版本、同步批次和本地业务项目建立外键；历史连接状态约束迁移后支持 `mapping_invalid`。
- Jira 连接支持 Bearer 与 Basic PAT 两种认证。所有请求沿用 DNS 固定、SSRF、受保护地址、超时、响应大小和秘密脱敏边界；POST JSON 另限制为 512 KiB。
- 能力探测严格读取当前用户、字段、项目、任务样例和状态。优先使用 POST search，不支持时才回退 GET；GET URL 超过 8,000 字符直接拒绝，不截断 JQL。
- `/status` 不可见时会从调用方可见的任务样例补全状态候选；401、403、资源不可见、字段/JQL 错误、限流、服务端错误和网络错误使用不同错误码，不把 Token 写入响应或日志。
- 字段向导覆盖计划开始、到期、Sprint、父任务、三类工时、经办人、状态、优先级、标签和组件 12 个用途；候选展示 ID、名称、schema、出现率与脱敏样例。
- 状态映射要求把全部可见原始状态映射到 `planned/in_progress/done/blocked/cancelled/other`；保存前验证字段存在、类型与样例可解析性，成功后创建不可变递增版本并保留审计。
- 业务项目可在同一向导绑定 Jira project key；键在数据库唯一，任务同步按该键归属本地项目，取消绑定不会删除历史任务。
- 后台支持默认、周报、季度、增量和全量五类结构化查询，不接受用户任意 JQL 拼接。周报范围同时覆盖更新时间、到期日和已映射计划开始字段；增量按 `updated ASC, key ASC`，保存 `lastUpdatedAt + issueKey` 复合水位并默认重叠回读 120 秒。
- 分页按服务端实际返回条数推进，允许 total 变化和缩页；拒绝起点倒退、循环、总数结束前空页和超过 500 页。只有所有页面成功后才推进水位；超时或字段漂移保留幂等观测但不冒充成功。
- 同一 `(connection, issue key)` 任务按内容哈希幂等 upsert。状态变化保存原始与统一状态，以及 `observed_interval` 观测区间；未知状态保留 ID/名称并归入 `other`，不按中文名称猜测。
- Jira 始终是 issue key 的主事实。任务保存标题、项目、类型、父子、排期、工时、Sprint、标签、组件和来源观测，但明确不持久化 description，也没有 Jira 写接口。
- 每 5 分钟为健康 Jira 连接创建去重的只读增量同步作业；全量核对成功后才把未见任务标为 `out_of_scope`。作业重放绑定原映射版本并依靠哈希收敛。
- 任务中心提供筛选、游标分页、增量同步触发、raw/normalized 状态、排期工时、来源、父子、映射版本、观测和状态时间线；设置页提供映射和项目绑定，五类结构化同步范围由统一 API 供当前及后续报告收集流程调用。

## 2. API 与只读边界

| 方法与路径 | 作用 | 约束 |
| --- | --- | --- |
| `GET /api/v1/integrations/:id/jira/capabilities` | 读取身份、搜索方式、字段、项目、状态、映射和水位 | 不返回凭证 |
| `GET /api/v1/integrations/:id/jira/mappings` | 读取不可变映射版本 | 只读 |
| `POST /api/v1/integrations/:id/jira/mappings` | 校验样例并创建新映射版本 | 旧版本不更新、不覆盖 |
| `POST /api/v1/integrations/:id/jira/sync` | 创建默认/周报/季度/增量/全量同步作业 | 只接受结构化 scope 和日期 |
| `GET /api/v1/integrations/:id/jira/runs` | 读取同步运行、计数、错误和水位摘要 | 只读 |
| `GET /api/v1/tasks` | 按状态、项目、来源、当前用户等筛选任务 | 稳定游标分页 |
| `GET /api/v1/tasks/:id` | 读取来源观测、状态区间、父子和映射详情 | description 固定不保存 |
| `PUT /api/v1/projects/:id` | 版本检查后更新 Jira project key 绑定 | 唯一键阻止一对多误绑 |

适配器没有创建、编辑、转换状态、记录工时或评论等 Jira 写能力。Jira API 客户端只暴露能力探测和 search 所需的 GET/POST 读取操作。

## 3. 防漏、漂移与恢复语义

1. 同步批次创建时绑定最新映射版本；运行期间即使用户新建映射，也不会改变该批次解释方式。
2. 查询从成功水位前 120 秒开始，稳定排序；跨页相同时间戳最终按 issue key 选出最大二元组。
3. 每页任务可幂等落库，以便中断后保留已取得事实；但 `lastSuccessRunId` 和水位只在整次完成的事务中更新。
4. 中间空页、页循环、页回退、超页、网络失败和解析失败都会把运行标为失败，并保存页面数、读数和安全错误摘要。
5. 字段删除、类型变化或非法工时进入 `mapping_invalid`，旧任务继续可读；用户重新探测并创建新映射版本后才能恢复推进。
6. 增量查询未见任务不删除、不改可见性；只有明确的全量个人核对完整成功后才标记 `out_of_scope`。
7. 无 changelog 时只记录两次观测间发生变化，页面和 API 均声明 `observed_interval`，不声称精确状态变化时刻。

## 4. 需求状态

| 需求 | 状态 | 本增量证据 | 发布前门禁 |
| --- | --- | --- | --- |
| JIR-001 | implemented | 认证、身份、字段、项目、POST/GET search、状态可见性和错误分类均有脱敏契约测试 | 使用企业只读账号验证实际版本、PAT scope、代理和权限 |
| JIR-002 | implemented | 12 用途字段、全状态、样例类型校验、不可变版本、项目绑定和映射漂移均已实现并自动化验证 | 使用企业实际自定义字段和 Sprint/父任务样例复核 |
| JIR-003 | verified | 同时间戳跨页、total 变化、缩页、重叠回读、第三页超时、中间空页、全量核对和水位不前进均有集成测试 | 企业环境复核分页上限和搜索兼容性 |
| JIR-004 | verified | raw ID/name 与 normalized 并存；未知状态归入 other 且原值保留；真实变化追加观测区间 | 新增企业状态时必须重新创建映射版本 |

`JIR-001/002` 未标为 `verified` 的唯一原因是仓库没有企业 Jira 地址、只读账号和真实字段样例；实现不会伪造外部验收成功，也不会因此退化为静态或简化版本。

## 5. 自动化与迁移证据

- Jira API、探测、规范化、查询策略和同步集成测试覆盖 Basic PAT 前置校验、POST/GET 回退、重试分类、样例状态兜底、未知状态、映射漂移、分页与水位恢复。
- 同步集成测试在隔离 SQLite 数据库上验证映射创建审计、内容哈希幂等、状态观测区间、父子链接、全量 `out_of_scope` 和部分页面失败恢复。
- 新空数据库依次应用 5 个生产迁移后 `prisma migrate status` 为最新；数据库与 Prisma datamodel 的 diff 为 `No difference detected`。
- SQLite `PRAGMA integrity_check` 返回 `ok`，`PRAGMA foreign_key_check` 返回空集合，5 条迁移全部处于完成且未回滚状态；一次性数据库随后已删除。
- 全仓 `pnpm verify` 的格式、lint、类型检查、测试和生产构建全部通过；测试结果为 contracts 2、domain 16、web 1、api 75，共 94 个测试。

## 6. 外部验收边界

本增量没有访问或写入任何企业 Jira，也没有使用浏览器自动化代替正式 API。发布前需要用户提供公司允许的只读测试连接，用可丢弃/脱敏项目完成 AC-JIR-01 与 AC-JIR-02；如果权限不足，产品应显示明确降级和缓存时效，不能把连接标为健康。
