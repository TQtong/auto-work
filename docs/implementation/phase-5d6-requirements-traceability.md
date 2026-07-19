# 阶段五 D6：全量需求追踪与跨模块终审

## 1. 终审口径

本终审逐项核对详细设计 01、08、09、10、11、12 中的业务规则、功能需求、非功能需求、HTTP 副作用契约、页面闭环、发布交付物和验收标准。状态只使用以下口径：

- `verified`：代码已实现，并有本机自动化、真实文件/数据库、浏览器或可重复基准证据；
- `implemented`：代码、契约测试和本机工作流已实现，但验收标准明确要求公司 GitLab/Jira/钉钉或真实 AI Provider，而当前工作区没有用户授权的企业测试资源；
- `blocked`：存在代码缺口或无法执行的本机门禁。本轮终审结束时没有 `blocked` 项。

`implemented` 不代表简化实现或待补代码。它只表示不能把 fixture、协议桩或本机页面冒充企业环境验收成功。

## 2. 业务规则追踪

| 规则        | 状态     | 实现与证据                                                                   |
| ----------- | -------- | ---------------------------------------------------------------------------- |
| BR-GEN-001  | verified | UTC 时间戳、`Asia/Shanghai` 业务日期策略贯穿任务、周报、季度、调度和导出测试 |
| BR-GEN-002  | verified | 内部不可变 ID 与来源命名空间外部键由 Prisma 唯一约束和全迁移集成测试覆盖     |
| BR-GEN-003  | verified | 外部写与正式结果使用幂等账本/业务唯一键；强制端点矩阵见第 5 节               |
| BR-GEN-004  | verified | 连接/仓库采用禁用，证据采用生命周期事件，确认、审计和导出快照不可变          |
| BR-GEN-005  | verified | 仓库、GitLab、Jira、任务和连接页面展示同步时间、新鲜度、过期或不可见状态     |
| BR-GIT-001  | verified | 真实路径规范化、`D:\company` 边界、一级发现和用户确认均有负向测试            |
| BR-GIT-002  | verified | 批次预检冻结仓库、动作、参数、HEAD、分支、工作区和跟踪状态                   |
| BR-GIT-003  | verified | 执行前重新采样并拒绝 HEAD/分支/工作区漂移，要求重新预检                      |
| BR-GIT-004  | verified | 逐仓库独立执行并持久化结果，单项失败不抹除已成功事实                         |
| BR-GIT-005  | verified | 命令模型与执行层双重固定 `pull --ff-only`、禁止 force push、校验分支基线     |
| BR-GIT-006  | verified | Stage 限定预检路径；Commit message 必填；Commit/Push 为独立批准动作          |
| BR-TSK-001  | verified | Jira 主记录、Excel 逐字段补空和来源替代生命周期有真实 SQLite 测试            |
| BR-TSK-002  | verified | `(updated, issueKey)` 水位、重叠窗口、同时间戳分页和恢复测试通过             |
| BR-TSK-003  | verified | 增量消失只标记本次不可见，全量核对才更新可见性                               |
| BR-XLS-001  | verified | 最近父任务继承限定单工作表，跨表不继承                                       |
| BR-XLS-002  | verified | 无子任务/经办人的容器行不生成个人任务，仍保留父维度                          |
| BR-XLS-003  | verified | 日期类型、序列和公式结果统一为业务日期并保留原单元格事实                     |
| BR-XLS-004  | verified | G 为空且 H 为 0 时工时仍为 `null`；人日只由 G/8 计算                         |
| BR-XLS-005  | verified | 文件只读预检、逐行修正、warning 知悉、幂等事务提交和哈希前后对账完成         |
| BR-WR-001   | verified | 覆盖周期、填写日期和版本化工作日历分离持久化                                 |
| BR-WR-002   | verified | 六字段严格校验，问题为空时确定性写入“暂无”                                   |
| BR-WR-003   | verified | 来源快照、规则/人工/AI 不可变版本及历史恢复链完整                            |
| BR-WR-004   | verified | 确认锁定明确版本，确认后编辑创建新草稿并失效旧确认                           |
| BR-WR-005   | verified | 正式日志与机器人意图、尝试、状态和恢复决议完全独立                           |
| BR-PERF-001 | verified | 成果按业务结果/证据聚合，代码明确禁止以 Commit 数、行数或工时直接计分        |
| BR-PERF-002 | verified | AI 只写建议字段；用户分和版本化公式独立计算、确认                            |
| BR-PERF-003 | verified | 季度确认冻结完整事实，Excel/Word 从确认快照生成且历史制品不可改写            |

## 3. 功能需求与验收标准追踪

验收标准与功能需求在详细设计 11 中一一映射，以下状态同时适用于对应 `AC-*`。

| 需求 / AC           | 状态        | 主要实现证据                                             | 未关闭的外部证据         |
| ------------------- | ----------- | -------------------------------------------------------- | ------------------------ |
| SYS-001 / AC-SEC-01 | verified    | loopback 监听、Host/Origin/CSRF 门禁与浏览器 UAT         | 无                       |
| SYS-002 / AC-OPS-01 | verified    | SQLite WAL、27 个迁移、备份校验、启动前原子恢复          | 无                       |
| SYS-003 / AC-OPS-02 | verified    | Jira/Git/提醒/备份调度、租约、休眠补偿和恢复测试         | 无                       |
| SYS-004 / AC-ID-01  | verified    | 本机用户、Git 作者别名、Jira 身份映射和归属测试          | 无                       |
| SEC-001 / AC-SEC-02 | verified    | DPAPI 保险箱、掩码、日志/诊断净化、秘密扫描              | 无                       |
| SEC-002 / AC-SEC-03 | implemented | 五类连接测试、待测试凭证轮换、禁用和撤销均实现           | 各公司连接最小权限实测   |
| SEC-003 / AC-SEC-04 | verified    | 写入、批准、外部提交、配置、测试发起/结果均写不可变审计  | 无                       |
| PRJ-001 / AC-PRJ-01 | verified    | `D:\company` 14 仓库真实发现与性能对账                   | 无                       |
| PRJ-002 / AC-PRJ-02 | implemented | HTTPS/SSH 远端解析、项目匹配、别名与基线确认             | 公司 GitLab 项目匹配 UAT |
| PRJ-003 / AC-PRJ-03 | verified    | 仓库中心完整读模型、新鲜度、异步刷新和浏览器验收         | 无                       |
| GLB-001 / AC-GLB-01 | verified    | 无 Token 时本地 Git 读写能力保持，页面明确降级           | 无                       |
| GLB-002 / AC-GLB-02 | implemented | 七类资源分页、能力差异、429/5xx、权限与字段兼容契约      | 公司 GitLab 版本联调     |
| GIT-001 / AC-GIT-01 | verified    | 全动作命令矩阵与隔离仓库集成测试                         | 无                       |
| GIT-002 / AC-GIT-02 | verified    | 跨仓预检、批准、逐项执行、取消和持久化结果               | 无                       |
| GIT-003 / AC-GIT-03 | verified    | HEAD/分支/工作区/远端漂移故障注入                        | 无                       |
| GIT-004 / AC-GIT-04 | verified    | API schema、命令策略和进程执行器三层禁止危险动作         | 无                       |
| JIR-001 / AC-JIR-01 | implemented | 授权、当前用户、字段、项目、搜索协议与错误映射已实现     | 公司 Jira 最小权限连接   |
| JIR-002 / AC-JIR-02 | implemented | 字段/状态映射不可变版本和变化回归完成                    | 公司自定义字段对账       |
| JIR-003 / AC-JIR-03 | implemented | 默认/周报/季度 JQL、防漏水位与分页测试完成               | 公司数据规模增量 UAT     |
| JIR-004 / AC-JIR-04 | implemented | raw/normalized 状态并存，未知状态 fixture 与页面筛选完成 | 公司实际状态目录对账     |
| XLS-001 / AC-XLS-01 | verified    | 三类工作表识别和真实 `.xlsx` 解析                        | 无                       |
| XLS-002 / AC-XLS-02 | verified    | 继承、容器、日期、空工时、G/8 黄金样例                   | 无                       |
| XLS-003 / AC-XLS-03 | verified    | 完整导入向导、事务提交和原文件哈希对账                   | 无                       |
| XLS-004 / AC-XLS-04 | verified    | Jira 主事实保护、逐字段来源与替代历史                    | 无                       |
| EVD-001 / AC-EVD-01 | verified    | issue key、分支、关键词、AI、人工关联优先级矩阵          | 无                       |
| EVD-002 / AC-EVD-02 | verified    | 建议、确认、拒绝、变化、撤销、过期完整生命周期           | 无                       |
| WRP-001 / AC-WRP-01 | verified    | 模板六字段、顺序、问题默认值和长度门禁                   | 无                       |
| WRP-002 / AC-WRP-02 | verified    | 任务/证据/计划/问题来源优先级和黄金样例                  | 无                       |
| WRP-003 / AC-WRP-03 | verified    | 规则/人工/AI 版本、快照、采纳拒绝和历史比较              | 无                       |
| WRP-004 / AC-WRP-04 | implemented | 编辑、确认、提交、恢复、重试、部分交付代码闭环           | 公司钉钉正式提交 UAT     |
| DNG-001 / AC-DNG-01 | implemented | 官方主机、模板/收件人能力、六字段正式日志和结果恢复      | 授权测试应用/模板实提    |
| DNG-002 / AC-DNG-02 | implemented | 加签机器人、摘要边界、提醒、频控、失败通知与测试轮换     | 授权专用测试群消息检查   |
| DNG-003 / AC-DNG-03 | implemented | 双通道独立意图、幂等、部分失败和人工恢复测试             | 企业网络异常/重放 UAT    |
| AI-001 / AC-AI-01   | implemented | OpenAI-compatible、Anthropic、Gemini 契约、探测和降级    | 三类授权 Provider 实测   |
| AI-002 / AC-AI-02   | verified    | 元数据白名单、源码/diff/秘密/主动内容净化负向测试        | 无                       |
| AI-003 / AC-AI-03   | verified    | AI 无工具权限，只产候选；用户分和最终动作不可写          | 无                       |
| QPR-001 / AC-QPR-01 | verified    | Jira/Git/MR/Pipeline/Release/周报/人工多来源收集         | 无                       |
| QPR-002 / AC-QPR-02 | verified    | 项目/成果聚类、稳定去重、证据保留与候选池 UAT            | 无                       |
| QPR-003 / AC-QPR-03 | verified    | 筛选、成果编辑、指标映射、正文、AI 建议和确认工作台      | 无                       |
| QPR-004 / AC-QPR-04 | verified    | 不同分项、范围/步长、公式版本、取整和独立计算对账        | 无                       |
| QPR-005 / AC-QPR-05 | verified    | Excel/Word 冻结导出、公式对账、文件 QA、下载且无提交端点 | 无                       |

## 4. 非功能需求追踪

| NFR / AC                     | 状态        | 证据                                                                 |
| ---------------------------- | ----------- | -------------------------------------------------------------------- |
| NFR-SEC-01 / AC-NFR-SEC-01   | verified    | 仅回环监听，Host/Origin/CSRF/CSP/下载安全与端口检查                  |
| NFR-PERF-01 / AC-NFR-PERF-01 | verified    | 14 仓库缓存首屏 P95 25.19 ms，阈值 2,000 ms                          |
| NFR-PERF-02 / AC-NFR-PERF-02 | verified    | 最慢单仓状态 P95 1,065.80 ms，阈值 5,000 ms                          |
| NFR-PERF-03 / AC-NFR-PERF-03 | verified    | 500 任务/2,000 证据规则生成 P95 45.25 ms，阈值 10,000 ms             |
| NFR-REL-01 / AC-NFR-REL-01   | verified    | 确认/提交不可变事实、作业租约、manual review、备份恢复故障测试       |
| NFR-REL-02 / AC-NFR-REL-02   | verified    | 强制幂等账本、业务唯一键、同事务结果冻结和并发重放测试               |
| NFR-AUD-01 / AC-NFR-AUD-01   | verified    | actor/time/target/approval/outcome 五要素、请求关联和非敏感摘要哈希  |
| NFR-UX-01 / AC-NFR-UX-01     | verified    | 风险二次确认、依据/来源、错误码、建议动作、空态与浏览器 UAT          |
| NFR-COMP-01 / AC-NFR-COMP-01 | implemented | GitLab/Jira/钉钉/AI 适配器与能力矩阵已实现；企业版本差异仍需授权联调 |

## 5. 强制幂等副作用端点

| 设计要求       | 后端门禁                                           | 原子/业务去重                        | 前端调用                     | 自动化                  |
| -------------- | -------------------------------------------------- | ------------------------------------ | ---------------------------- | ----------------------- |
| Git 批准       | `Idempotency-Key` + 请求哈希                       | 批次批准/作业唯一性                  | 仓库批次页生成键             | 批次重放与漂移测试      |
| Excel 提交     | `Idempotency-Key` + preview/version/warning        | 任务、来源、审计、响应同事务         | 导入向导稳定提交键           | 同键/冲突/回滚测试      |
| 周报确认       | `Idempotency-Key` + 多版本门禁                     | 确认、审计、响应同事务               | 周报工作台动作键             | 快照与重放测试          |
| 正式日志提交   | `Idempotency-Key` + 显式确认                       | intent/job/ledger 同事务、业务唯一键 | 危险确认弹窗                 | 重放/unknown/恢复测试   |
| 机器人通知     | `Idempotency-Key` + 正式日志成功门禁               | 独立 intent/job/ledger 与静默窗口    | 独立二次确认                 | 部分失败/频控测试       |
| 季度确认       | `Idempotency-Key` + 完整性知悉                     | 快照、版本、审计、响应同事务         | 绩效工作台生成键             | 同键同体/异体/业务重放  |
| 季度导出       | `Idempotency-Key` + confirmation/format            | 冻结快照身份与活动制品唯一性         | 绩效工作台生成键             | 重放/重排/文件 QA       |
| 机器人连接测试 | 专用路由 + `confirmSendTestMessage: true` + 幂等键 | 连接、单例作业、审计、202 响应同事务 | 设置页 Popconfirm + 显式字段 | 绕过/缺键/重放/单次作业 |

## 6. 跨模块写入与审计抽样

终审重新枚举全部 Controller 的 `POST/PUT/DELETE`，并追到最终事务或控制器审计。关键类别如下：

| 类别         | 审计动作示例                                                                             | 并发/恢复保护                                          |
| ------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 配置与身份   | `profile.updated`、别名状态、日历版本、`integration.updated/disabled/credential_revoked` | version/updateMany、不可变版本、保险箱补偿             |
| 同步与作业   | GitLab/Jira sync requested、operation cancel、连接 test requested/completed              | 活动作业去重、租约、取消、结果审计                     |
| Git 写入     | preview/approved/item result/cancel                                                      | 快照漂移、批准会话、逐仓状态机                         |
| Excel 与任务 | preview resolution/commit、task override/revoke/expired                                  | previewVersion、任务 version、幂等事务、来源历史       |
| 证据         | suggest/confirm/reject/change/revoke/expire                                              | 关系 version、事件序列、幂等响应                       |
| 周报与钉钉   | version/confirm/delivery/recovery/notification/attachment                                | 聚合 version、不可变确认、intent 唯一键、manual review |
| 季度绩效     | achievement/evidence/mapping/score/narrative/confirm/export                              | 双版本锁、冻结确认、制品身份、事务审计                 |
| 运维         | retention/diagnostics/backup/verify/restore/pending cancel                               | 预览哈希、强确认、隔离校验、启动前清单                 |

审计只保存非敏感摘要哈希和净化错误码，不保存 Token、Webhook、Secret、周报正文、附件内容或外部原始响应。

## 7. 交付物与诚实边界

源码、27 个迁移、API/Web 生产构建、自动化测试、NFR 基准、发布门禁、CycloneDX SBOM、Windows 安装升级回滚脚本、运行手册、已知限制和阶段实现证据均已纳入仓库。

本轮代码终审没有遗留本机可实现功能缺口。尚未提升为 `verified` 的项目全部依赖用户授权的公司 GitLab/Jira/钉钉/AI 测试资源；在获得这些资源前，发布签字必须保留对应外部 UAT 项，不能用测试桩替代。

最终候选提交 `87f28adea672f6c87d013a8b6cb348d7101853e2` 已通过完整 `pnpm release:gate`：68 个测试文件/298 个用例、两端生产构建、27 迁移空库部署、389 个跟踪文件秘密扫描、生产依赖 high 门禁、CycloneDX 1.6 SBOM 和 508 文件候选 ZIP 全部通过。
