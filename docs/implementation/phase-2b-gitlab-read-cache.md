# 阶段二 B：GitLab 能力探测与只读缓存实现与验证

## 1. 完整实现范围

- GitLab 连接配置支持 HTTPS 基础地址、DPAPI Token、数字项目 ID、完整 `namespace/project`、首次历史窗口和启停状态。
- 能力探测按 `/version`（允许端点不可见）→ `/user` → 最多 20 个配置项目执行，保存当前用户、版本可见性、分页能力、已允许/明确禁止资源和逐项目可见性；未检查数量明确记录，不伪造全量验证。
- 项目解析优先使用 URL 编码后的数字 ID/完整路径；路径直查返回 404 时才搜索，且只采用大小写完全一致的 `path_with_namespace`，不会仅按名称自动匹配。
- 所有列表显式 `per_page=100`，优先跟随 `Link rel=next`，兼容 `X-Next-Page`；没有分页头时停止，不按返回条数猜页；分页主机、端口和 API 前缀不能越界。
- 分页读取项目、分支、Commit、MR、Pipeline、Tag、Release 和项目成员。只保存 UI/证据需要的摘要，不读取 repository files、diff、job log 或 variable。
- Commit、MR、Pipeline 首次使用可配置历史窗口；后续从项目最后完整成功水位向前重叠 15 分钟后 upsert。分支、Tag、Release、成员在完整列表成功后标记未见项 `stale`。
- 每个项目保存 `unknown/refreshing/fresh/error` 持久化同步状态、错误摘要和最后完整成功时间；页面超过 10 分钟派生为 `stale`。失败不会覆盖最后成功时间，配置范围只有整次成功后才失效旧项目。
- 持久化 `gitlab.sync` 作业安全重放、同连接去重、429/5xx 最多三次重试、`Retry-After`/指数退避、逐次同步运行统计与错误分类；不可重试的 4xx 不会被通用作业恢复器盲目重放。单项目失败后其余项目继续，连接级认证/限频/网络失败立即停止放大请求。
- 提供项目汇总、同步运行和七类具体资源的只读游标分页 API；具体资源 API 校验连接与项目归属，不允许跨连接读取。
- 仓库匹配同时校验 GitLab connection ID、host、非默认 port 和完整大小写路径；保存的项目 ID 只有仍满足精确匹配才展示。不同实例的相同数字 project ID 不会串接，远端主机、端口或路径改变会把仓库置为 `needs_review`。
- 仓库中心拼接 GitLab 默认分支、最近远端 Commit、开放 MR、当前分支 MR、最新 Pipeline 的 ref/SHA、新鲜度和错误；Pipeline SHA 与本地 HEAD 不一致时明确提示，绝不把缓存流水线当作当前 HEAD 事实。
- 设置页可配置历史窗口、查看非秘密配置/能力矩阵、触发后台同步，并查看全部项目缓存、八类资源计数、Pipeline 和最后同步状态。

## 2. 网络与秘密安全边界

1. Token 只从 DPAPI 保险箱取出并放入 `PRIVATE-TOKEN` 请求头，不进入 URL、作业摘要、数据库、能力矩阵或错误详情。
2. 外部客户端只允许无 URL 凭证的 HTTPS；不跟随 HTTP 重定向，每页链接必须保持批准的协议、主机、端口和 `/api/v4/` 前缀。
3. 请求前解析全部 DNS 地址，任一地址越过策略则整体拒绝；连接固定到已校验地址，防止 DNS 轮询/重绑定。loopback、link-local、metadata、multicast 及 IPv4-mapped IPv6 形式始终拒绝。
4. 企业 GitLab 可显式访问 RFC1918/ULA 私网，但不能借此访问本机或 metadata；响应限制 4 MiB，请求 20 秒超时。
5. 认证/权限/不可见/限频/服务端错误使用稳定错误码。401/403/404 不重试；429/5xx 才执行受限重试。
6. GitLab 适配器只注册读取能力，没有创建/修改项目、MR、Pipeline、成员、文件或变量的端口。

## 3. 需求状态

| 需求        | 状态        | 本增量证据                                                                                        | 后续                                                         |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| PRJ-002     | implemented | host + port + 完整大小写路径匹配、项目 ID 保存、远端变化复核、直查与精确搜索回退均已实现          | 企业 GitLab 项目重命名/大小写/非默认端口 UAT 后提升 verified |
| PRJ-003     | implemented | 仓库中心已拼接最近远端 Commit、开放/当前分支 MR、Pipeline ref/SHA 与新鲜度                        | 阶段三补 Jira 任务摘要后完成整项                             |
| GLB-001     | verified    | GitLab 模块没有连接或 Token 时不会参与仓库发现、状态读取或受限 Git；原有无 Token 端到端回归仍通过 | 继续作为全量 UAT 门禁                                        |
| GLB-002     | implemented | 八类资源、分页、项目水位、快照失效、真实 SQLite 持久化和失败不半写已自动化验证                    | 缺少公司最小权限 Token/版本，企业联调前不能标 verified       |
| SEC-001     | implemented | Token 仅经 DPAPI 和请求头流转；协议测试及错误结构不包含凭证                                       | 发布前再执行全仓秘密扫描与企业代理日志核查                   |
| NFR-COMP-01 | implemented | 版本端点可不可见、可选字段缺失、未知新增字段、Link/X-Next-Page 双路径和稳定错误分类均有契约测试   | 公司具体 GitLab 版本联调后固化录制样例                       |

## 4. 自动化与运行证据

- GitLab REST 契约测试覆盖三页混合分页、无分页头停止、跨主机 Link 拒绝、项目路径 URL 编码、`.git` 归一化、大小写精确搜索回退、401/403/404、429 与 `Retry-After`。
- 八类脱敏响应样例覆盖可选字段缺失、服务端新增字段及非法 SHA 阻断；能力探测覆盖版本端点 404、真实用户/项目能力、缺配置与无效凭证。
- 真实临时 SQLite 集成测试逐条应用三版生产迁移，完整写入项目、分支、Commit、MR、Pipeline、Tag、Release、成员和同步运行；第二次注入非法 Commit 后验证失败项目进入 `error`、另一个项目仍完成、旧缓存保留且预先校验阻止分支半写入。测试同时覆盖稳定 project ID 优先、跨 connection 隔离、内部选择 ID 到外部 ID 的确认映射、空范围失效旧项目和七类资源读取。
- SSRF 回归覆盖 IPv4 loopback、metadata、IPv4-mapped IPv6 loopback/metadata、跨主机请求和企业私网许可差异。
- 全仓 `pnpm verify` 通过：contracts 2、domain 14、web 1、api 29，共 46 个测试；lint、类型检查、生产构建全部通过。
- 新数据目录从空库执行三版 `prisma migrate deploy` 与 `prisma migrate status` 成功，外键和 CHECK 约束生效。
- 生产构建在全新无 GitLab Token 数据目录启动为 `ready`，真实允许根完成 18 个仓库发现；本地仓库列表、状态和刷新不依赖 GitLab。
- 浏览器使用脱敏缓存夹具验证项目缓存弹窗、八类计数、当前分支 MR、最近远端 Commit、Pipeline ref/SHA、新鲜度和完整同步时间；1280 px 视口无页面水平溢出。QA 同时发现并修复了“无本机凭证仍可入队同步”的前后端边界。

## 5. 外部验收边界

当前工作区没有公司 GitLab 地址、最小权限测试 Token、实例版本或可安全使用的测试项目，因此没有对公司系统发请求，也没有把模拟数据描述为企业联调成功。`GLB-002` 保持 `implemented`；取得测试资源后必须按 AC-GLB-02 复跑全部资源分页、429/5xx、权限不足、项目不可见、非默认端口和字段差异，并把脱敏结果附到 PR 才能提升为 `verified`。
