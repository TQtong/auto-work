# 阶段五 D4：调度与性能终审增量

## 1. 终审发现与修正

本增量不是只补验收文档。逐条核对 `SYS-003`、`NFR-PERF-01` 至 `NFR-PERF-03` 和详细设计性能表后，确认并修正了两个实现缺口：

1. 原实现有 GitLab、Jira、提醒和备份调度，但没有每五分钟刷新本地 Git 元数据的调度器；
2. 原 `repository.sync` 作业逐仓库串行执行，与“本地状态刷新全局并发 2”的设计不一致。

修正后：

- `RepositorySyncSchedule` 每五分钟第 15 秒检查可刷新仓库，只在存在 `discovered/confirmed/needs_review` 仓库时排入只读 `repository.sync` 作业；
- 定时刷新和用户“刷新全部”共享固定 `repository.sync:all` 去重键，持久化队列保证 queued/running 期间不重复扫描；
- 作业处理器使用两个有界 worker，单仓库异常只形成该项失败结果；结果仍按原始仓库顺序返回；
- 每次领取仓库前读取持久化取消标记，已开始的只读命令自然结束，未领取项不再执行；
- 返回 `total/processed/cancelled/results`，并按完成数持续写入进度。

自动化 `repository-sync-schedule.spec.ts` 和 `repository-job-handlers.spec.ts` 覆盖空仓库跳过、去重参数、并发上限、失败隔离、稳定顺序、进度及取消。

## 2. 可重复性能基准

新增根命令：

```powershell
pnpm benchmark:nfr
```

基准程序先执行生产构建，然后：

- 从空目录应用全部生产迁移，建立本次运行独占的临时 SQLite；
- 插入 14 个仓库缓存、14 个项目、14 个 Git 快照和 10,000 个任务；
- 预热后至少测量 20 轮，正式证据使用 30 轮；
- 构造 500 个任务和 2,000 条已确认 Git/GitLab 证据，调用真实确定性周报规则；
- 扫描 `D:\company` 一级目录，要求恰好识别 14 个真实 Git 仓库；
- 对每个仓库预热后至少测量 5 轮，正式证据使用 10 轮真实 `collectStatus`；
- 使用 `git count-objects -v` 的 pack 大小把仓库分成 small/medium/large 三层；
- 门禁使用“最慢单仓库 P95”，不会用全体平均掩盖慢仓库；
- JSON 保留每轮原始样本，Markdown 给出签字表；两者都不保存源码、diff、凭证和 Git 命令输出；
- 任何阈值、样本数量或 14 仓库数量不符均以非零状态退出；临时数据库只清理 `mkdtemp` 返回的精确目录。

## 3. 提交绑定的正式结果

使用已推送提交 `c2f68ba` 的基准程序，在 Node v22.14.0 / Windows 上执行：

```powershell
node scripts/benchmarks/nfr-performance.mjs `
  --rounds 30 `
  --git-rounds 10 `
  --output docs/verification/nfr-performance-report
```

结果全部通过：

| 验收项                      |                    正式规模 |         P95 |      阈值 |
| --------------------------- | --------------------------: | ----------: | --------: |
| AC-NFR-PERF-01 仓库缓存首屏 |              14 仓库，30 轮 |    25.19 ms |  2,000 ms |
| 任务列表容量                |        10,000 条，30 轮分页 |    36.87 ms |  2,000 ms |
| AC-NFR-PERF-03 周报规则     |  500 任务/2,000 证据，30 轮 |    45.25 ms | 10,000 ms |
| AC-NFR-PERF-02 本地状态     | 14 仓库各 10 轮，取最慢单仓 | 1,065.80 ms |  5,000 ms |

原始结果见 [JSON 报告](../verification/nfr-performance-report.json) 和 [Markdown 报告](../verification/nfr-performance-report.md)。其中最大仓库 pack 约 8.51 GiB，small/medium/large 三层均有真实样本。

## 4. 边界

本增量关闭本地调度和三项 NFR 性能验收证据，但不把 Jira 企业实例网络耗时、真实企业 Excel 模板或企业钉钉/GitLab 联调伪装为已验证。它们继续按终审矩阵分别标明本地实现证据与外部环境阻塞。
