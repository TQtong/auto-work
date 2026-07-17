# 实现追踪

本目录将详细设计中的需求、实现、自动化测试和人工验收证据绑定到同一个增量。状态含义如下：

- `implemented`：代码路径已经实现，但尚未完成该需求的全部验收矩阵。
- `verified`：正向、关键异常、安全或恢复场景均已获得可复现证据。
- `blocked`：企业环境或外部能力尚不可用，已提供明确降级而未伪造成功。
- `planned`：设计范围内但尚未开始实现。

只有达到 `verified` 才视为需求完成；页面占位、静态数据和跳过异常路径都不能提升状态。

| 增量 | 范围 | 文档 | 状态 |
| --- | --- | --- | --- |
| 01 | 基础、安全内核、持久化作业、备份、SPA 壳 | [阶段一实现与验证](./phase-1-foundation.md) | implemented |
| 02A | 仓库发现、注册表、只读 Git 状态与仓库中心 | [阶段二 A 实现与验证](./phase-2a-repository-read-model.md) | verified |
| 02B | GitLab 能力探测与只读缓存 | [阶段二 B 实现与验证](./phase-2b-gitlab-read-cache.md) | implemented |
| 02C | 受限 Git 动作、批次预检、批准与执行 | [阶段二 C 实现与验证](./phase-2c-restricted-git-batches.md) | verified |
| 03 | Jira、Excel、任务与证据 | 待提交 | planned |
| 04 | 周报、钉钉、AI 建议 | 待提交 | planned |
| 05 | 季度绩效、导出、运维与发布门禁 | 待提交 | planned |

每次增量必须同步更新本表，并在 PR 中保留对应提交、验证命令和人工检查结果。
