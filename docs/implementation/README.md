# 实现追踪

本目录将详细设计中的需求、实现、自动化测试和人工验收证据绑定到同一个增量。状态含义如下：

- `implemented`：代码路径已经实现，但尚未完成该需求的全部验收矩阵。
- `verified`：正向、关键异常、安全或恢复场景均已获得可复现证据。
- `blocked`：企业环境或外部能力尚不可用，已提供明确降级而未伪造成功。
- `planned`：设计范围内但尚未开始实现。

只有达到 `verified` 才视为需求完成；页面占位、静态数据和跳过异常路径都不能提升状态。

| 增量   | 范围                                              | 文档                                                             | 状态        |
| ------ | ------------------------------------------------- | ---------------------------------------------------------------- | ----------- |
| 01     | 基础、安全内核、持久化作业、备份、SPA 壳          | [阶段一实现与验证](./phase-1-foundation.md)                      | implemented |
| 02A    | 仓库发现、注册表、只读 Git 状态与仓库中心         | [阶段二 A 实现与验证](./phase-2a-repository-read-model.md)       | verified    |
| 02B    | GitLab 能力探测与只读缓存                         | [阶段二 B 实现与验证](./phase-2b-gitlab-read-cache.md)           | implemented |
| 02C    | 受限 Git 动作、批次预检、批准与执行               | [阶段二 C 实现与验证](./phase-2c-restricted-git-batches.md)      | verified    |
| 03A    | Jira 能力探测、版本化映射、防漏同步与任务主事实   | [阶段三 A 实现与验证](./phase-3a-jira-task-sync.md)              | implemented |
| 03B1   | Excel 容器安全、三表解析与持久化预检              | [阶段三 B1 实现与验证](./phase-3b1-excel-safe-preview.md)        | verified    |
| 03B2   | Excel 预检修正、确认提交、逐字段补充与 provenance | [阶段三 B2 实现与验证](./phase-3b2-excel-commit-provenance.md)   | verified    |
| 03B3   | Excel 导入向导、冲突处理与字段来源 UI             | [阶段三 B3 实现与验证](./phase-3b3-excel-import-ui.md)           | verified    |
| 03C    | Git/GitLab 证据建议、确认与生命周期               | [阶段三 C 实现与验证](./phase-3c-evidence-lifecycle.md)          | verified    |
| 04A1   | 六字段周报确定性规则、来源块与黄金样例            | [阶段四 A1 实现与验证](./phase-4a1-weekly-rule-core.md)          | implemented |
| 04A2   | 工作日历、周报来源快照、不可变规则版本与来源链接  | [阶段四 A2 实现与验证](./phase-4a2-weekly-snapshot-core.md)      | implemented |
| 04A3a  | 周报编辑/恢复、附件、模板/收件人事实与确认内核    | [阶段四 A3a 实现与验证](./phase-4a3-weekly-edit-confirm-core.md) | implemented |
| 04A3b+ | 周报工作台、AI、钉钉与交付恢复                    | 待提交                                                           | planned     |
| 05     | 季度绩效、导出、运维与发布门禁                    | 待提交                                                           | planned     |

每次增量必须同步更新本表，并在 PR 中保留对应提交、验证命令和人工检查结果。
