# 04 项目、Git 与 GitLab 详细设计

## 1. 功能边界

本模块提供仓库发现、项目登记、本地状态采集、GitLab 只读元数据、受控 Git 写操作和批次结果管理。GitLab API 不替代本地 Git：工作区、Index、本地分支和真实写操作必须来自 `git.exe`；GitLab 提供远端平台视角。

## 2. 仓库发现

### 2.1 扫描规则

1. 根目录固定默认 `D:\company`，先规范化并验证存在、为目录且非 UNC/设备路径。
2. 只枚举一级子目录，不递归寻找嵌套仓库，以免范围失控。
3. 普通仓库识别 `.git` 目录；worktree 允许 `.git` 文件但需解析其 gitdir，验证目标仍是合法仓库元数据。
4. 忽略无权访问、重解析点逃逸、bare 仓库和状态不可判定目录，并在发现报告中列明原因。
5. 对每个候选执行只读身份命令，取得顶层路径、git dir、HEAD、remote 列表和默认 remote。
6. 与已有 registry 按规范路径、仓库 identity 和 remote URL 匹配：同路径新 identity 进入 `needs_review`，不能继承旧白名单。
7. 新仓库状态为 `discovered`；用户确认显示名、项目归属、remote 和基线后转 `confirmed`。
8. 已登记但本次不存在的仓库标记 `missing`；不删除历史。

### 2.2 URL 规范化

支持 HTTPS、SSH scp-like、SSH URL。规范化结果只保存：协议类别、host、port（非默认时）、path_without_dot_git、namespace、project path。URL 中嵌入的用户名或凭证必须丢弃/脱敏。host 必须与已配置 GitLab host 匹配后才自动建议项目。

大小写不可擅自统一：GitLab path 匹配优先使用 API 返回的 `path_with_namespace`；本地比较可生成辅助小写键，但保留原值并在碰撞时要求人工选择。

### 2.3 GitLab 项目匹配

优先级：

1. 已保存的 GitLab project ID 仍可访问且 path 相符。
2. 使用 URL 编码后的完整 namespace/project path 查询。
3. API 搜索结果中精确 path 匹配。
4. 不自动采用仅名称相同的项目；给用户候选和差异。

确认后保存 project ID 和 web URL。远端 URL 后续变化触发匹配复核，不静默迁移。

## 3. 仓库中心读模型

列表行由本地最新状态、GitLab 最新缓存、任务证据摘要拼成，显示：

- 项目/别名、本地路径、可用性和最后刷新时间。
- 当前/默认/基线分支，detached HEAD 警告。
- staged、unstaged、untracked、conflicted 数量。
- upstream、ahead/behind、未推送 Commit 数；未 fetch 时标“基于缓存”。
- 最近本地 Commit 和最近远端 Commit。
- 最新 Pipeline 状态及时间；开放 MR 数和与当前分支相关 MR。
- 关联 Jira 父任务/当前子任务数量、未确认关联数量。

页面加载读取缓存，不同步阻塞 14 个仓库；“刷新全部”创建后台读任务，并逐行更新。单仓库刷新可提升优先级。

## 4. Git 状态采集

### 4.1 采集内容

- 仓库顶层和 Git 目录。
- HEAD SHA、symbolic branch、detached/unborn 状态。
- upstream ref、ahead/behind。
- porcelain v2 状态：普通、重命名、未跟踪、未合并冲突。
- 最近提交的 SHA、作者/邮箱、时间、标题。
- remote 名称和 URL（脱敏）。
- stash 列表摘要。

路径按 Git 的原始字节/quoting 规则安全解析，展示与执行使用同一规范化路径对象，避免包含空格、Unicode、换行或前导 `-` 的文件被误解释为参数。

### 4.2 超时和大仓库

常规只读命令默认 5 秒，网络 Git 默认 120 秒，可配置上限。输出超过限制时保存截断摘要并标记 `output_truncated`。未跟踪文件扫描过慢时允许用户对仓库设置受控优化，但不能默认忽略影响预检正确性的路径。

## 5. GitLab 同步

### 5.1 认证与连接测试

测试顺序：基础 URL HTTPS 校验 → `/api/v4/version`（若有权）→ `/api/v4/user` → 选定项目读取。保存当前用户 ID/name、实例版本（若可见）、权限错误类别和能力矩阵。401 视为凭证无效，403 视为权限不足，404 需区分资源不可见/端点不可用。

### 5.2 拉取策略

- 所有列表端点显式 `per_page`，优先跟随响应 `Link rel=next`，兼容 `X-Next-Page`；不得根据返回数量自行猜页。
- 项目 ID 可以是数字或 URL 编码 path，内部优先使用数字 ID。
- Commit、MR、Pipeline 使用时间窗口和项目级水位，重叠抓取后 upsert。
- 分支是快照型集合：整次成功后标记未见分支 stale。
- Tag、Release 和项目成员按项目分页读取；成员仅保存只读身份/访问级别摘要，不把 GitLab 成员角色映射为本机操作权限。
- 默认只抓取用于界面的必要字段；不获取 repository files、diff、job logs 或变量。
- 429/5xx 遵循 Retry-After 和指数退避；认证/权限错误不自动重试。

### 5.3 数据新鲜度

本地状态 5 分钟、GitLab 元数据 10 分钟为默认刷新间隔。页面用 `fresh/stale/refreshing/error` 显示，不把 GitLab Pipeline 缓存与当前本地 HEAD 混为一谈；若 SHA 不同，明确标注对应 ref/SHA。

## 6. 结构化动作模型

| 动作 | 必要参数 | 预检重点 | 成功判定 |
|---|---|---|---|
| fetch_prune | remote | 仓库/remote 可用、无活跃写锁 | fetch 退出 0，刷新远端引用 |
| pull_ff_only | remote、branch | 工作区策略、当前分支、upstream、可快进 | `--ff-only` 成功且 HEAD 为预期后继 |
| create_branch | branch、baseline | 分支名合法、不存在、基线可解析 | 新分支指向预检基线并 checkout |
| checkout | target branch | 分支存在、切换不覆盖修改 | 当前分支为目标 |
| push_set_upstream | remote、branch | 本地分支、远端冲突、非 force | upstream 建立且远端包含 SHA |
| push | remote、refspec（受限） | upstream、非快进风险 | 普通 push 成功 |
| stash_create | message、include_untracked | 有可 stash 修改、路径状态 | 产生新 stash OID |
| stash_apply | stash OID | OID 存在、工作区影响/冲突风险 | apply 退出 0；冲突则 needs_review |
| stage_paths | 明确路径列表 | 路径来自快照、仍在仓库 | Index 状态符合所选路径 |
| commit | message、预期 staged 摘要 | staged 非空、HEAD/Index 未变、身份可用 | 新 Commit 产生，父为预检 HEAD |

命令语义必须固定：`fetch_prune` 等价于受控的 `git fetch <remote> --prune`；`pull_ff_only` 等价于 `git pull --ff-only`（可带已验证 remote/branch）；首次推送只允许普通 `git push --set-upstream`，后续只允许普通 `git push`。展示层可以用更易读的顺序显示选项，但 Worker 参数模板必须经过测试并保持同等安全语义。

### 6.1 明确禁止的表达

动作 schema 明确不提供 `push --force`（含 `--force-with-lease`）、`reset --hard`、merge、rebase、branch delete、clean、submodule 任意更新、hook 控制、config 写入或 raw args。Worker 也需拒绝参数中的未知选项、NUL、换行注入、路径越界和以 `-` 冒充选项的非路径值。

## 7. 预检设计

### 7.1 批次创建

请求包含动作、动作参数、仓库 ID 集合，不接受路径。API 对集合去重、排序并限制数量（首版至少覆盖 14，建议上限 50）。批次内容在创建后不可修改；参数变化产生新批次。

### 7.2 单项预检输出

- 当前 HEAD/分支/upstream 和工作区摘要。
- 将执行的可读命令展示；敏感 URL 脱敏。
- 预计变化：创建/切换分支、拉取提交区间、推送 ref、Stage 路径、Commit 内容摘要。
- 风险等级：info/warning/blocking。
- 前置条件和阻断原因。
- 预检快照哈希、过期时间。

预检不是 dry-run 的简单包装。Git 缺少可靠 dry-run 的动作必须用只读引用图、状态和规则计算影响；不得为了预检临时修改仓库。

### 7.3 各动作关键规则

- Pull：工作区有会受影响的修改则阻断；没有 upstream 时阻断并建议先设置；非快进时阻断，不切换到 merge。
- Create branch：使用 Git check-ref-format 语义；分支存在则按“已满足/冲突”区分，绝不覆盖。
- Checkout：未提交更改可能被覆盖时阻断；不自动 stash。
- Push：比较本地与远端引用；远端包含未知更新时阻断并提示 fetch；任何 force 意图都不存在。
- Stash apply：显示 stash 基准与涉及路径；无法保证无冲突时给 warning，发生冲突后停止该仓库后续动作。
- Stage：展示精确路径和状态，预检后新增文件不自动加入。
- Commit：保存 Index tree/hash 和 HEAD；执行时两者均须一致；Git hook 可能改变或拒绝提交，结果如实记录。

## 8. 批准与执行

用户在确认页看到全部仓库结果，只能勾选可执行项。批准记录包含批次版本、选中项、影响摘要、确认时间和会话。若全部项被阻断不能批准。

执行前逐项：获取仓库锁 → 重采关键状态 → 比较快照 → 运行固定动作 → 采集操作后状态 → 释放锁。快照不符标 `stale_preview`，不影响其他仓库。用户可取消尚未开始的项；运行中的 Git 进程只在安全超时/取消机制下终止，终止后进入复核。

### 8.1 结果分类

- `succeeded`：动作与后置条件均满足。
- `already_satisfied`：执行前发现目标已由外部操作完成，未重复写。
- `skipped_by_user`：未获批准。
- `stale_preview`：关键状态变化。
- `blocked`：执行前规则不满足。
- `failed`：命令明确失败且副作用可判定。
- `needs_review`：超时、终止、hook/冲突导致结果需人工检查。

批次汇总不得用单个“成功/失败”掩盖逐仓库差异。

## 9. 操作后的恢复与建议

- Pull 非快进：建议 fetch 后查看差异，不提供自动 merge/rebase。
- Checkout 冲突/阻断：列出受影响路径，建议用户手工处理或单独批准 stash。
- Stash apply 冲突：展示冲突文件和 stash OID；不得自动 drop stash。
- Push 被拒：展示远端领先，建议 fetch；不建议 force。
- Commit hook 失败：保留 Index 状态，显示脱敏 stderr；不得跳过 hooks。
- Worker 超时：刷新状态并标 needs_review，不猜测失败或自动重跑写命令。

## 10. Git 与 Jira 友好约定

系统可建议分支名 `<ISSUE-KEY>-<short-slug>` 和 Commit message 包含 issue key，但不强制改写用户文本。建议前校验项目允许的 issue key；分支创建仍走独立预检/批准。证据关联不能反向自动改变 Jira。

## 11. 验收重点

- 14 仓库全部被发现且白名单外路径无法操作。
- HTTPS/SSH remote 都能正确解析且凭证不入库。
- 无 GitLab Token 时本地状态和受控 Git 仍工作。
- 所有允许动作有正向、状态变化、超时、冲突和多仓库部分失败测试。
- UI 展示命令与 Worker 实际动作一一对应，但 UI 文字不能成为执行输入。
- 危险命令从 API schema、领域枚举、Worker 三层均不可表达。
