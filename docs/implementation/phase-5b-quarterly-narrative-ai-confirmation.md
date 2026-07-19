# 阶段五 B：季度自评、AI 建议与确认冻结

## 1. 状态与边界

05B 已完成季度自评规则版本、人工版本、AI 候选版本、逐指标 AI 分数建议、显式采纳/拒绝、确认前置检查、完整性知悉和可重建确认快照，状态为 `verified`。

本阶段没有把 AI 建议写入用户分，也没有让模型选择成果、调用工具或决定最终总分。Excel/Word 导出、渲染 QA 与完整绩效工作台属于 05C；运维、诊断、发布门禁和全量文档终审属于 05D。

## 2. 自评版本

自评固定为五部分：总体概述、按成果/指标组织的核心成果、协作与能力成长、问题与改进、下一周期计划。系统支持三类不可变版本：

- `rule`：只依据已选择成果生成确定性结构，不依赖外部 AI；
- `ai`：供应商返回并通过本地引用/事实校验的候选版本，不切换当前正文；
- `manual`：用户新建、编辑、恢复历史版本或显式采纳 AI 后形成的人工版本。

编辑和恢复均新建版本，原版本由数据库触发器禁止更新。正文中的成果、证据和指标 ID 必须属于当前评审、当前已选成果及 active 指标映射。AI 候选只有显式采纳后才创建人工派生版本并切换当前正文；拒绝和采纳均为不可逆决策。生成 AI 候选不会覆盖已有人工正文，也不会使已经确认的快照失效。

## 3. AI 白名单与结果校验

季度 AI 复用已探测健康的三协议 Provider 连接（OpenAI-compatible、Anthropic、Gemini），并新增评审归属、基线评审版本、采纳自评版本和用途索引。每次生成保留供应商配置版本、模型、协议、请求 ID、耗时、用量、净化策略版本、输入引用摘要、输入哈希、解析结果及失败/阻断原因。

发送前重新构造白名单对象，仅包含：

- 评审名称、周期与时区；
- 当前版本指标 ID、代码、名称、定义、范围、步长和必填标记；
- 已选择成果的五段结构、贡献边界、周期、active 指标映射；
- 可用证据的类型、标题、外部键、发生时间、可用状态、贡献角度，以及来源摘要中白名单量化键的值。

源码、diff、附件正文、URL、人员标识、凭证和原始来源 JSON 没有进入发送对象的字段通道。输入和输出仍经过秘密、源码、diff 与主动内容扫描。

评分建议要求每个当前指标分别返回建议分、区间、理由、证据缺口、不确定性和引用。校验器拒绝：指标集合缺失或重复、范围/步长错误、未知引用、未映射到指标的成果引用、无引用日期/数字/工单号、`userScore` 等额外字段。成功后只更新 `aiSuggested*`、AI 理由/缺口/不确定性和 generation ID，写入对象中不包含 `userScore`、`userReason` 或总分贡献。

自评建议必须返回五个完整章节且每章至少一个引用。未知引用、虚构日期/数字、代码围栏和 HTML 会使生成失败。Provider 不可用时记录失败生成；当前没有正文时自动创建规则自评，已有人工正文时保持原指针不变。

## 4. 最终确认与失效

确认前置检查分为不可知悉绕过的 blocker 和必须逐项知悉的材料风险。

不可绕过条件包括：至少一项已选成果、已绑定指标模板、当前自评正文存在、全部启用必填指标均有合法用户分和理由。以下材料风险允许继续，但必须提交代码和人工说明：已选成果缺证据、缺 active 指标映射、必填指标缺成果覆盖、证据重复引用、来源未达到 fresh/not-applicable。

确认时在同一事务内重新读取并冻结：

1. 评审周期和基线版本；
2. 已选成果、五段正文、贡献边界、全部证据摘要和 active 指标映射；
3. 指标模板版本、公式、取整规则和指标定义；
4. 逐指标用户分、用户理由、原始贡献；
5. 仅由用户分和版本化公式计算的明细、未舍入总分和最终总分；
6. 当前自评版本完整正文；
7. 材料完整性结果及逐项知悉记录。

确认表同时保存上述五类 JSON 正文和成果/评分/总快照哈希，后续导出不需要回读已经变化的活动数据。确认接口强制要求格式有效的 `Idempotency-Key`，以当前用户、路由、键和规范请求哈希建立账本；同键同请求返回首次结果，同键不同请求返回 409。确认快照、聚合版本、审计事件和幂等响应在同一数据库事务提交，业务层发现同一基线已确认时也会完成本次幂等账本，避免网络重试产生第二份确认或长期停留在处理中。确认后修改成果、证据、指标映射、模板、用户评分或当前正文时，旧确认只从 `active` 单向迁移到 `invalidated`，历史冻结内容不改写、不删除。

## 5. 数据库不变量

第 24 个迁移新增季度 AI 归属和基线、AI 采纳自评版本、五类确认正文、用途索引及以下数据库级约束：

- AI 生成的评审归属与 owner 必须一致；周报/季度 pending 建议分别具备正确基线；
- AI 生成事实不可变，采纳/拒绝只能从 pending 单向迁移；采纳版本必须由对应 generation 派生；
- 自评版本 origin、JSON、哈希、父版本和 AI generation 归属有效，版本不可变；
- 当前自评/当前确认指针必须属于同一评审，当前确认必须 active；
- 确认模板和正文必须是评审当时绑定/当前的版本；冻结 JSON 必须有效；
- 确认除 active → invalidated 的时间和原因外全部不可变。

迁移已部署到本地数据库。`prisma migrate status` 显示 24 个迁移全部最新，`PRAGMA integrity_check` 为 `ok`，`PRAGMA foreign_key_check` 为空。

## 6. API

| 端点                                                                     | 行为                                  |
| ------------------------------------------------------------------------ | ------------------------------------- |
| `GET /api/v1/quarterly-reviews/:id/narratives`                           | 列出规则、AI、人工自评版本            |
| `GET /api/v1/quarterly-reviews/:id/narratives/:versionId`                | 读取指定不可变自评正文                |
| `POST /api/v1/quarterly-reviews/:id/narratives/rule`                     | 生成确定性规则自评并切换当前版本      |
| `POST /api/v1/quarterly-reviews/:id/narratives/manual`                   | 新建经引用校验的人工自评版本          |
| `POST /api/v1/quarterly-reviews/:id/narratives/:versionId/restore`       | 从历史版本创建新的人工恢复版本        |
| `POST /api/v1/quarterly-reviews/:id/ai/score-suggestion`                 | 生成逐指标 AI 建议，不写用户分        |
| `POST /api/v1/quarterly-reviews/:id/ai/narrative`                        | 生成不切换当前正文的 AI 候选版本      |
| `GET /api/v1/quarterly-reviews/:id/ai-generations`                       | 按用途查看生成账本摘要                |
| `GET /api/v1/quarterly-reviews/:id/ai-generations/:generationId`         | 查看净化引用、原始/解析输出和失败事实 |
| `POST /api/v1/quarterly-reviews/:id/ai-generations/:generationId/adopt`  | 显式采纳 AI 自评为人工派生版本        |
| `POST /api/v1/quarterly-reviews/:id/ai-generations/:generationId/reject` | 显式拒绝 AI 建议                      |
| `GET /api/v1/quarterly-reviews/:id/confirmation-preflight`               | 返回 blocker、知悉项和完整性清单      |
| `POST /api/v1/quarterly-reviews/:id/confirmations`                       | 冻结当前完整评审并安全重放            |
| `GET /api/v1/quarterly-reviews/:id/confirmations`                        | 列出 active/invalidated 确认历史      |
| `GET /api/v1/quarterly-reviews/:id/confirmations/:confirmationId`        | 读取完整可重建冻结快照                |

## 7. 验证证据

- 新增 AI 策略测试覆盖：额外 `userScore` 字段、越界/非步长建议、虚构数字、未知引用、虚构日期、五章节完整性；
- 新增真实 SQLite 全迁移集成测试覆盖：规则自评、完整性知悉、确认冻结、确认后评分失效、AI Provider 失败规则回退、AI 候选不覆盖当前正文、显式采纳、AI 建议不改用户分；
- 季度确认集成测试进一步覆盖：缺失幂等键被拒绝、校验失败账本收尾、同键同体精确重放、同键异体冲突、业务重复确认以及确认记录唯一性；
- 季度四个测试文件共 13 个用例通过；
- 全量测试通过：Contracts 1 个文件/2 个用例、Domain 9 个文件/35 个用例、API 43 个文件/214 个用例、Web 6 个文件/17 个用例；
- 全仓格式检查、lint、类型检查和生产构建均通过。

## 8. 后续增量

05C 将基于确认表中的可重建冻结正文生成 Excel/Word，完成公式对账、文件安全、渲染 QA、下载与重新生成，并实现“周期与数据 → 候选池 → 成果编辑 → 指标映射 → 分数 → 自评 → 确认与导出”的完整绩效工作台。05D 再完成运维诊断、备份恢复、发布门禁和全量文档终审。
