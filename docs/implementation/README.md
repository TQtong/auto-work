# 实现追踪

本目录将详细设计中的需求、实现、自动化测试和人工验收证据绑定到同一个增量。状态含义如下：

- `implemented`：代码路径已经实现，但尚未完成该需求的全部验收矩阵。
- `verified`：正向、关键异常、安全或恢复场景均已获得可复现证据。
- `blocked`：企业环境或外部能力尚不可用，已提供明确降级而未伪造成功。
- `planned`：设计范围内但尚未开始实现。

只有达到 `verified` 才视为需求完成；页面占位、静态数据和跳过异常路径都不能提升状态。

| 增量     | 范围                                              | 文档                                                                         | 状态        |
| -------- | ------------------------------------------------- | ---------------------------------------------------------------------------- | ----------- |
| 01       | 基础、安全内核、持久化作业、备份、SPA 壳          | [阶段一实现与验证](./phase-1-foundation.md)                                  | implemented |
| 02A      | 仓库发现、注册表、只读 Git 状态与仓库中心         | [阶段二 A 实现与验证](./phase-2a-repository-read-model.md)                   | verified    |
| 02B      | GitLab 能力探测与只读缓存                         | [阶段二 B 实现与验证](./phase-2b-gitlab-read-cache.md)                       | implemented |
| 02C      | 受限 Git 动作、批次预检、批准与执行               | [阶段二 C 实现与验证](./phase-2c-restricted-git-batches.md)                  | verified    |
| 03A      | Jira 能力探测、版本化映射、防漏同步与任务主事实   | [阶段三 A 实现与验证](./phase-3a-jira-task-sync.md)                          | implemented |
| 03B1     | Excel 容器安全、三表解析与持久化预检              | [阶段三 B1 实现与验证](./phase-3b1-excel-safe-preview.md)                    | verified    |
| 03B2     | Excel 预检修正、确认提交、逐字段补充与 provenance | [阶段三 B2 实现与验证](./phase-3b2-excel-commit-provenance.md)               | verified    |
| 03B3     | Excel 导入向导、冲突处理与字段来源 UI             | [阶段三 B3 实现与验证](./phase-3b3-excel-import-ui.md)                       | verified    |
| 03C      | Git/GitLab 证据建议、确认与生命周期               | [阶段三 C 实现与验证](./phase-3c-evidence-lifecycle.md)                      | verified    |
| 04A1     | 六字段周报确定性规则、来源块与黄金样例            | [阶段四 A1 实现与验证](./phase-4a1-weekly-rule-core.md)                      | implemented |
| 04A2     | 工作日历、周报来源快照、不可变规则版本与来源链接  | [阶段四 A2 实现与验证](./phase-4a2-weekly-snapshot-core.md)                  | implemented |
| 04A3a    | 周报编辑/恢复、附件、模板/收件人事实与确认内核    | [阶段四 A3a 实现与验证](./phase-4a3-weekly-edit-confirm-core.md)             | implemented |
| 04A3b    | 完整周报工作台、版本交互、确认预检与浏览器验收    | [阶段四 A3b 实现与验证](./phase-4a3b-weekly-workbench.md)                    | verified    |
| 04B1     | AI 三协议、真实连接测试、统一 usage/停止原因      | [阶段四 B1 实现与验证](./phase-4b1-ai-provider-protocols.md)                 | implemented |
| 04B2a    | AI 白名单净化、引用事实校验、不可变生成留痕       | [阶段四 B2a 实现与验证](./phase-4b2a-ai-sanitization-persistence.md)         | implemented |
| 04B2b    | AI 建议服务、版本采纳/拒绝、确定性降级与工作台    | [阶段四 B2b 实现与验证](./phase-4b2b-ai-suggestion-workflow.md)              | verified    |
| 04C1     | 钉钉日志/机器人协议、模板探测与凭证安全轮换       | [阶段四 C1 实现与验证](./phase-4c1-dingtalk-capability-probes.md)            | implemented |
| 04C2     | 正式日志创建、机器人摘要与双通道幂等              | [阶段四 C2 实现与验证](./phase-4c2-dingtalk-dual-channel-delivery.md)        | implemented |
| 04C3a    | 结果查询、人工裁决、受控新 attempt 与恢复工作台   | [阶段四 C3a 实现与验证](./phase-4c3a-dingtalk-delivery-recovery-core.md)     | implemented |
| 04C3b1   | 机器人 429/5xx 有界重试与调用证据                 | [阶段四 C3b1 实现与验证](./phase-4c3b1-dingtalk-robot-retry.md)              | implemented |
| 04C3b2a  | 通知账本、安全模板、状态版本去重与静默合并        | [阶段四 C3b2a 实现与验证](./phase-4c3b2a-robot-notification-ledger.md)       | implemented |
| 04C3b2b1 | 明确失败提醒、独立通知作业/API 与页面账本         | [阶段四 C3b2b1 实现与验证](./phase-4c3b2b1-failure-notification-workflow.md) | implemented |
| 04C3b2b2 | 严重风险规则配置、风险通知触发与页面选择          | [阶段四 C3b2b2 实现与验证](./phase-4c3b2b2-severe-risk-notification.md)      | verified    |
| 04C3b3a  | 预约正式提交显式批准、准确调度与失效取消门禁      | [阶段四 C3b3a 实现与验证](./phase-4c3b3a-scheduled-delivery-guard.md)        | verified    |
| 04C3b3b1 | 提醒策略、工作周、Asia/Shanghai 计划内核与设置页  | [阶段四 C3b3b1 实现与验证](./phase-4c3b3b1-reminder-policy-core.md)          | verified    |
| 04C3b3b2 | 提醒滚动计划、休眠补发与超时 skipped              | [阶段四 C3b3b2 实现与验证](./phase-4c3b3b2-reminder-scheduler.md)            | verified    |
| 04C3b3c  | 六字段复制与附件导出降级                          | [阶段四 C3b3c 实现与验证](./phase-4c3b3c-export-copy-fallback.md)            | verified    |
| 05       | 季度绩效、导出、运维与发布门禁                    | 待提交                                                                       | planned     |

每次增量必须同步更新本表，并在 PR 中保留对应提交、验证命令和人工检查结果。
