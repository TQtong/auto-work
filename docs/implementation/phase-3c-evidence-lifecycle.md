# 阶段三 C：Git/GitLab 证据建议与生命周期

## 1. 当前增量状态

03C 按可独立复核的提交拆分实现。当前 03C1 已完成纯领域匹配内核和关联矩阵，03C2a 已完成统一持久化、GitLab 六类来源物化、拒绝抑制、重新建议、来源失效和复核标记；确认/拒绝/撤销/手工关系 API、用户审计及任务证据 UI 会在本阶段后续提交继续完成。因完整生命周期尚未闭环，本阶段状态为 `implemented`，不能提前视为 `verified`。

## 2. 03C1 领域匹配内核

- issue key 只从配置中已知的 Jira project key 提取，使用左右边界和严格正整数编号，避免把普通单词、未知项目或非法编号误判为任务。
- 同一分支、Commit 或 MR 中出现多个 issue key 时，为每个任务分别产生建议，不武断只取第一个。
- 分支名、Commit 标题/消息、MR 标题和 MR 来源分支分别使用设计规定的 `1.00 / 0.98 / 0.98 / 0.95` 置信度；同一任务与证据只保留最高确定性依据。
- Pipeline 不解析普通 ref 猜任务，只能在同 GitLab 项目、同 SHA 且 Commit 关系已经确认时，以 `0.95` 继承该关系。
- 关键词建议必须同时满足同项目、45 天时间窗口和标题关键词重合，置信度硬上限 `0.79`，始终要求人工确认。
- 方法排序明确区分人工、确定性规则、关键词和 AI；AI 不会覆盖本地确定性规则或人工决定。

## 3. 自动化证据

`evidence-matching.spec.ts` 覆盖 5 组关联矩阵：已知项目/边界/非法编号、多 key 一对多、四种确定性来源、Pipeline 已确认继承、跨项目/超时窗口拒绝、关键词上限及方法排序。当前 domain 共 6 个测试文件、21 个测试全部通过，同时通过 ESLint 和 TypeScript 类型检查。

## 4. 03C2a 持久化与来源物化

- 新增 `Evidence`、`EvidenceLink`、`EvidenceLinkEvent` 三个模型；来源事实、当前关系和不可变状态事件分离保存。
- SQLite 直接约束来源类型、可用性、关系状态、方法、复核状态、目标类型、task target 一致性、版本正数及 `0～1` 置信度，不把数据完整性只留给应用代码。
- GitLab 完整成功同步后才运行证据物化；项目同步有失败页时不会使旧建议过期。Branch、Commit、MR、Pipeline、Tag、Release 均使用内部来源 ID 幂等 upsert，不保存代码 diff。
- 同一 GitLab 项目只有在唯一映射到本地项目时才启用关键词规则；歧义映射保留证据但不猜项目。
- 来源内容哈希只覆盖业务事实，不把每次同步时间混入哈希；同步时间独立更新，不会让确认关系无故进入复核。
- 已拒绝关系在内容哈希和规则版本不变时保持拒绝并抑制重复建议；二者变化后才恢复为 suggested，并写 `resuggested` 事件。
- 已确认关系在来源内容/可用性或规则依据变化后保持 confirmed，但标记 `needs_revalidation`；来源消失时证据标 unavailable，未确认建议转 expired，历史关系不删除。
- Pipeline 关系只在 Commit 已确认后产生，且要求同 GitLab 项目和同 SHA。

`evidence-materializer.integration.spec.ts` 从空库应用全部生产迁移，覆盖六类物化、一对多建议、拒绝抑制/解除、Pipeline 继承、确认关系复核、来源不可用、未确认过期以及数据库约束拒绝。GitLab 原同步测试同时断言：完整成功才调用物化，部分失败不调用。

全仓 `pnpm verify` 通过：contracts 2、domain 21、API 92、Web 3，合计 118 个测试；格式、Lint、类型检查和两端生产构建全部成功。全新 SQLite 数据库应用 8 条迁移后状态最新、Prisma schema diff 为零、`integrity_check=ok`、外键违规为 0。

## 5. 后续门禁

只有以下路径全部实现并通过 SQLite 集成测试及真实浏览器验收后，03C 才能提升为 `verified`：

1. GitLab 六类来源物化为统一 Evidence，内容变化和不可见状态可追踪；
2. 建议幂等、拒绝在相同内容哈希/规则版本下抑制，变化后才允许重新建议；
3. 确认、拒绝、撤销、手工关系、过期和 `needs_revalidation` 均保留不可变事件与审计；
4. 任务详情按 confirmed/suggested/rejected/expired 展示时间线、方法、置信度、理由和新鲜度；
5. `AC-EVD-01` 关联矩阵与 `AC-EVD-02` 生命周期 E2E 均取得可复现证据。
