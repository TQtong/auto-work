# NFR 性能基准报告

- 生成时间：2026-07-19T00:37:20.826Z
- 提交：`c2f68bad636f75207c022ba89e06ce2b0e8a2855`
- Node：v22.14.0
- 仓库根目录：`D:\company`
- 总结：**全部通过**

## 门禁结果

| 验收项         | 场景                            |         实测 / 阈值 | 结果 |
| -------------- | ------------------------------- | ------------------: | ---- |
| AC-NFR-PERF-01 | 14 仓库缓存首屏                 |  25.19 ms / 2000 ms | 通过 |
| 任务列表容量   | 10,000 条本地记录分页           |  36.87 ms / 2000 ms | 通过 |
| AC-NFR-PERF-03 | 500 任务/2,000 证据规则生成     | 45.25 ms / 10000 ms | 通过 |
| AC-NFR-PERF-02 | 最慢单仓库本地状态刷新          | 1065.8 ms / 5000 ms | 通过 |
| PRJ-001        | 真实仓库根目录一级 Git 仓库数量 |             14 / 14 | 通过 |

## 真实仓库分层

| 仓库                      | 分层   | pack KiB | P95 ms | 最大 ms |
| ------------------------- | ------ | -------: | -----: | ------: |
| cesiumlabsource           | large  |   802006 | 802.72 |  802.72 |
| cps-converter-server      | medium |   319106 | 436.18 |  436.18 |
| cps-converter-ui          | large  |   398027 | 526.39 |  526.39 |
| cps-extent-map-web        | small  |    33989 | 515.47 |  515.47 |
| cps-fds-surface-web       | medium |   132353 | 509.97 |  509.97 |
| cps-soonbi-web            | medium |    88917 | 665.67 |  665.67 |
| enterprise-web            | small  |    39743 | 430.13 |  430.13 |
| login-web                 | small  |    23689 | 1065.8 |  1065.8 |
| operate-web               | small  |     4023 | 503.38 |  503.38 |
| soonmanager-bimeditor-web | medium |   124629 |  514.6 |   514.6 |
| soonmanager-web           | medium |    56392 | 441.44 |  441.44 |
| soonspacejs               | large  |  2823033 | 473.09 |  473.09 |
| ugis-sdk-expand           | small  |    10431 | 430.24 |  430.24 |
| ugis-web                  | large  |  8919964 | 438.22 |  438.22 |

> JSON 同名文件保留每轮原始样本；本报告不包含源码、diff、远端凭证或 Git 输出。
