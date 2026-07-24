# 阶段二 A：仓库发现与只读状态实现与验证

## 1. 完整实现范围

- 配置允许根目录的真实路径校验：拒绝 UNC、设备路径、不存在路径和非目录。
- 只枚举一级子目录；跳过重解析点，不递归发现嵌套仓库。
- 支持普通仓库和 `.git` 文件 worktree；Git 元数据目录必须仍位于允许根内。
- 拒绝 bare 仓库、非顶层目录和身份不可判定目录，并在发现作业结果中逐项记录原因。
- 采集顶层、Git 目录、HEAD、symbolic branch、unborn/detached、remote 和仓库身份哈希。
- 解析 HTTPS、SSH URL 和 scp-like remote；入库前删除用户名、密码、查询和 `.git` 后缀。
- 使用 `git status --porcelain=v2 --branch -z` 读取空格和 Unicode 路径，统计 staged、unstaged、untracked、conflicted、ahead/behind、upstream、stash 和最近提交。
- 首次发现只登记 `discovered`；人工确认显示名、项目、远端和基线后才进入 `confirmed` 白名单。
- 相同路径的 Git 身份变化进入 `needs_review`；本次缺失进入 `missing`；禁用只移出白名单而不删除历史。
- 持久化发现/刷新作业、逐仓部分失败结果、5 分钟本地新鲜度和最近 20 份详情快照。
- 业务项目创建、仓库查询/确认/更新/禁用、单仓库与批量刷新 API。
- 生产仓库中心页面：发现、刷新、项目归属、白名单确认、工作区/分支/新鲜度、详情和禁用。

## 2. 安全执行边界

1. Git 子进程按平台固定调用 `git.exe`（Windows）或 `git`（Linux/macOS）参数数组，`shell: false`，不接受 raw command、cwd 或附加参数；Docker bind mount 只为当前已校验仓库注入精确 `safe.directory`，禁止 `*` 通配放宽。
2. 清除继承的 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、对象目录和 `GIT_SSH_COMMAND`，关闭交互凭证提示和可选锁。
3. 参数中的 NUL、CR、LF 在启动子进程前拒绝；输出限制为 2 MiB，常规只读命令超时 5 秒。
4. 远端明文只在内存中经过规范化；数据库和 API 只包含无凭证 URL。
5. 发现与读取不自动把仓库加入可写白名单，也不执行 fetch、checkout、stage、commit 或 push。
6. 仓库路径每次刷新都重新 realpath、校验一级范围和身份；路径被替换后不能沿用旧白名单。

## 3. 需求状态

| 需求         | 状态        | 本增量证据                                                          | 后续                                              |
| ------------ | ----------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| PRJ-001      | verified    | 自动化一级/嵌套范围测试；真实允许根发现 18 个一级仓库并保存逐项状态 | 企业指定 `D:\company` 的 14 仓 UAT 在发布阶段复跑 |
| PRJ-002      | implemented | 三类 URL 解析、凭证脱敏、别名/项目/远端/基线确认均已实现            | 02B 加入 GitLab project ID 精确匹配候选           |
| PRJ-003      | implemented | 本地分支、工作区、ahead/behind、最近提交、新鲜度和完整 UI 已实现    | 02B/阶段三拼接 MR、Pipeline 和任务摘要            |
| GLB-001      | verified    | 没有任何 GitLab 连接时，发现、状态刷新、确认和仓库中心端到端成功    | 保持为回归门禁                                    |
| GLB-002      | planned     | 本增量没有伪造 GitLab 缓存                                          | 02B 实现所有分页资源                              |
| GIT-001～004 | planned     | 本增量只提供不可写的 Git 进程基础与参数安全测试                     | 02C 独立实现、批准和验收全部动作                  |

## 4. 自动化与运行证据

- Git 远端规范化测试覆盖带凭证 HTTPS、scp-like SSH、SSH URL、Windows 本地路径和非法输入。
- Windows 临时真实仓库测试覆盖：提交、Unicode/空格路径、暂存、修改、未跟踪、嵌套仓库阻断和控制字符参数阻断。
- API 实际发现当前允许根，持久化作业 `succeeded`；Git Worker 健康握手返回 `git version 2.49.0.windows.1`。
- 当前仓库确认到业务项目后状态为 `confirmed`，随后单仓库后台刷新成功；远端 URL 不含 `@` 或凭证。
- 仓库中心 1280×720 检查无水平页面溢出、无浏览器控制台错误；白名单确认弹窗完整展示项目、远端、基线和安全警示。
