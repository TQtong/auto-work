# 阶段三 C：Git/GitLab 证据建议与生命周期

## 1. 当前增量状态

03C 按可独立复核的提交拆分实现。当前 03C1 已完成纯领域匹配内核和关联矩阵，03C2a 已完成统一持久化、GitLab 六类来源物化、拒绝抑制、重新建议、来源失效和复核标记，03C2b 已完成确认/拒绝/撤销/手工关系 API、幂等、乐观锁、自动过期和事务审计；任务证据 UI 与真实浏览器验收会在本阶段后续提交继续完成。因页面闭环尚未完成，本阶段状态为 `implemented`，不能提前视为 `verified`。

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

## 5. 03C2b 生命周期 API 与事务审计

| 方法与路径                                       | 作用                                             | 写入门禁                    |
| ------------------------------------------------ | ------------------------------------------------ | --------------------------- |
| `GET /api/v1/tasks/:id/evidence`                 | 分状态读取任务关系、证据事实和不可变事件         | 只读；惰性收敛到期关系      |
| `GET /api/v1/evidence`                           | 按来源、可用性、项目分页读取可手工绑定的证据目录 | 只读                        |
| `POST /api/v1/evidence-links/:id/confirm`        | 确认建议或重新确认变化后的来源                   | version + `Idempotency-Key` |
| `POST /api/v1/evidence-links/:id/reject`         | 保存明确拒绝与原因                               | version + 原因 + 幂等键     |
| `POST /api/v1/evidence-links`                    | 将现有证据手工绑定到任务并立即确认               | 关系唯一 + 说明 + 幂等键    |
| `DELETE /api/v1/evidence-links/:id/confirmation` | 撤销确认/拒绝但保留关系和历史                    | version + 撤销原因 + 幂等键 |

- 所有用户写入使用条件版本更新；并发修改返回 `412 EVIDENCE_LINK_VERSION_STALE`，不会覆盖新决定。
- 关系变更、EvidenceLinkEvent、AuditEvent 和 completed 幂等响应在同一 SQLite 事务提交；失败请求将幂等记录收敛为 failed，并额外写 rejected/failed 审计。
- 同 key 同请求返回原响应，同 key 不同请求返回幂等冲突；缺失或非法 key 在进入业务事务前拒绝。
- 自动规则的确认/拒绝撤销后回到 suggested；手工关系撤销后转 expired。两者都不物理删除，事件序列可完整回放。
- 确认支持可选有效期；15 分钟调度和读路径都会收敛到期关系。系统过期使用条件版本更新，写 `expired` 系统事件及 `evidence.link_expired` 审计。
- 重新确认会把 `needs_revalidation` 恢复为 valid，并把确认依据更新到当前来源内容哈希。

`evidence-lifecycle.integration.spec.ts` 从空库应用全部生产迁移，覆盖成功确认与重放、过期版本/failed 幂等、拒绝与撤销、手工绑定唯一性、手工撤销保留、定时过期、事件/审计原子性、目录分页、非法游标、缺失幂等键、严格 body 和同 key 不同请求。

03C2b 完成后的全仓 `pnpm verify` 再次通过：contracts 2、domain 21、API 98、Web 3，合计 124 个测试，格式、Lint、类型检查和两端生产构建全绿。

## 6. 后续门禁

只有以下路径全部实现并通过 SQLite 集成测试及真实浏览器验收后，03C 才能提升为 `verified`：

1. GitLab 六类来源物化为统一 Evidence，内容变化和不可见状态可追踪；
2. 建议幂等、拒绝在相同内容哈希/规则版本下抑制，变化后才允许重新建议；
3. 确认、拒绝、撤销、手工关系、过期和 `needs_revalidation` 均保留不可变事件与审计；
4. 任务详情按 confirmed/suggested/rejected/expired 展示时间线、方法、置信度、理由和新鲜度；
5. `AC-EVD-01` 关联矩阵与 `AC-EVD-02` 生命周期 E2E 均取得可复现证据。
