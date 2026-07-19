# 阶段二 C：受限 Git 批次安全工作流实现与验证

## 1. 完整实现范围

- 建立 `GitBatch`、`GitBatchItem`、`GitOperationEvent` 三类持久化模型，分别保存批次状态机、逐仓预检/结果和不可变操作事件；仓库与历史批次保持外键关联。
- 完整实现 `fetch_prune`、`pull_ff_only`、`create_branch`、`checkout`、`push_set_upstream`、`push`、`stash_create`、`stash_apply`、`stage_paths`、`commit` 十个结构化动作，不提供 raw command、cwd、附加参数或高级字符串入口。
- `create_branch` 先把基线解析为提交 OID，再用固定参数创建并切换；脏工作区阻断，同名分支只在指向同一基线时允许安全切换，绝不覆盖。
- 批次最多接收 50 个已确认仓库 ID，服务端去重、排序并逐仓独立预检；页面显示 HEAD、分支、上游、领先/落后、工作区、Index 哈希、可读命令、预计影响、风险和阻断原因。
- 预检只执行只读命令。Index 绑定通过 `git ls-files --stage -z` 的字节级 SHA-256 完成，不使用会写对象库的 `write-tree`；快照 10 分钟后过期。
- 批准保存快照版本、选中仓库、逐项风险确认和确认会话；Push/Commit 等敏感动作必须再输入精确短语 `确认执行`。`Idempotency-Key` 重放返回同一操作，不重复执行。
- Worker 获取逐仓写锁后重新校验真实路径、仓库身份、HEAD、分支、上游、工作区、Index 和动作事实；任一关键条件变化只把当前项标记为 `stale_preview`，不会执行写命令，也不阻断其他仓库。
- 执行结果完整区分 `succeeded`、`already_satisfied`、`skipped_by_user`、`stale_preview`、`blocked`、`failed`、`needs_review`，批次汇总区分全部完成、部分失败、失败和待复核。
- 运行中写命令超时、进程终止或作业崩溃时不自动重放，批次进入人工复核；未开始批次可通过专用端点取消，不能绕过 Git 批次状态机调用通用作业取消。
- 提供批次列表、创建预览、读取详情、批准和取消 API，并交付完整“受限 Git 批次”页面：专用动作表单、最多 50 仓选择、倒计时、逐仓展开、确认门槛、轮询进度、结果和恢复建议。

## 2. 十个动作的固定语义

| 动作 | 固定写命令语义 | 关键保护与后置条件 |
| --- | --- | --- |
| `fetch_prune` | `git fetch <remote> --prune` | 远端必须存在；更新并清理远端跟踪引用 |
| `pull_ff_only` | `git pull --ff-only [remote branch]` | 当前分支、上游、工作区和实时远端拓扑复核；非快进阻断，不 merge/rebase |
| `create_branch` | `git checkout -b <branch> <baseline-oid>` | 基线先解析为提交；脏工作区阻断；同名不同提交阻断；成功后创建并切换 |
| `checkout` | `git checkout <local-branch>` | 只接受已存在本地分支；脏工作区阻断；不自动 stash |
| `push_set_upstream` | `git push --set-upstream <remote> <full-refspec>` | 实时读取远端引用；只允许普通推送；首次推送与普通推送分开批准 |
| `push` | `git push <remote> <full-refspec>` | 跟踪引用必须新鲜；远端前进、分叉或未知时阻断；不存在任何 force 变体 |
| `stash_create` | `git stash push [-u] -m <message>` | 无变更时已满足；是否包含未跟踪文件必须显式选择；记录新 stash OID |
| `stash_apply` | `git stash apply <oid>` | OID 必须存在；展示涉及路径；冲突转 `needs_review` 且不自动 drop |
| `stage_paths` | `git add -- <paths...>` | 路径必须来自预检变更集合并留在仓库内；新增文件不会被自动加入 |
| `commit` | `git commit -m <message>` | message 非空、暂存区非空、无冲突、HEAD 与 Index 未变；正常运行 hooks |

所有命令均通过 `spawn('git.exe', args)`、`shell: false` 执行。进程层清理危险 Git 环境变量、禁用交互凭证和 askpass、限制输出并在源头脱敏 URL 用户信息、Token、secret 和 password。参数层拒绝 NUL、换行、非法 ref、路径逃逸、前导短横线和未知动作；API schema、领域白名单和 Worker 形成三层不可表达边界。

## 3. API、状态机与审计

| 方法与路径 | 作用 | 状态约束 |
| --- | --- | --- |
| `GET /api/v1/git/batches` | 分页读取最近批次 | 只读 |
| `POST /api/v1/git/batches/preview` | 创建持久化预检作业 | 仅已确认白名单仓库；返回 `202` |
| `GET /api/v1/git/batches/:id` | 读取批次、逐项快照和结果 | 只读并惰性处理过期 |
| `POST /api/v1/git/batches/:id/approve` | 绑定版本和选择批准执行 | 必须待批准、未过期、风险已确认；支持幂等键 |
| `POST /api/v1/git/batches/:id/cancel` | 取消尚未开始的批次 | 已执行项和运行中写操作不能伪装为安全取消 |

预检、批准、开始执行、快照过期、逐仓结果和最终汇总都会写入状态事件；每个仓库另写审计事件。批准通过交互式 Prisma 事务抢占版本，避免并发批准重复创建执行作业。预检作业可安全重放；写作业只恢复到人工复核，不猜测副作用，也不自动再次运行 Git。

## 4. 需求状态

| 需求 | 状态 | 本增量证据 | 持续门禁 |
| --- | --- | --- | --- |
| GIT-001 | verified | 十个动作均有真实临时仓库正向执行；分支创建后切换、Pull/Push/Stash/Stage/Commit 后置条件均断言 | 后续版本继续运行完整动作矩阵 |
| GIT-002 | verified | 14 个真实临时仓库持久化 E2E：2 个批准后改变 HEAD，最终 12 成功、2 个 `stale_preview`、批次 `partial_failed`，逐项结果与审计均保留 | 发布 UAT 再使用企业指定的可丢弃仓库复跑 |
| GIT-003 | verified | HEAD 变化、Commit 前 Index 变化、同路径仓库身份替换均在写入前阻断；失败仓库不影响其他项 | 所有新增写动作必须绑定其关键事实 |
| GIT-004 | verified | API 拒绝 force/reset/merge/rebase/raw command/cwd/args；领域层拒绝 ref、路径和动作注入；Worker 只有十个固定参数模板且无 Shell | 新动作必须先扩展三层白名单与安全矩阵 |

## 5. 自动化与运行证据

- `git-batch-schemas.spec.ts` 覆盖十个动作的合法专用结构，以及 force、reset、merge、rebase、raw command、cwd 和 args 的拒绝。
- `git-batch-engine.spec.ts` 在 Windows 临时普通仓库和裸远端执行全部十个写动作，并覆盖脏工作区创建分支阻断、预览后工作区变化、Commit 前 Index 变化、Pull/Push 分叉、stash 冲突保留、hook 失败、路径/ref/动作注入及仓库身份替换。
- `git-batch-workflow.integration.spec.ts` 从空 SQLite 逐条应用全部生产迁移，建立 14 个真实临时仓库，验证持久化预检、批准、幂等重放、串行执行、部分失败、审计和状态事件；12 个成功仓库同时断言已切换到目标分支。
- 新数据目录执行四个生产迁移后 `prisma migrate status` 成功；迁移目录与 Prisma schema 的 diff 为 `No difference detected`。
- 全仓 `pnpm verify` 覆盖格式、lint、类型检查和生产构建，测试结果为 contracts 2、domain 14、web 1、api 58，共 75 个测试全部通过。
- 浏览器使用工作区内一次性数据目录和可丢弃仓库完成白名单确认、分支批次预览、逐仓命令/影响检查、人工批准、Worker 执行和最终结果轮询；结果为 1/1 成功，Git 引用与预检基线 OID 一致。
- 1280 px 桌面视口下 `documentElement.scrollWidth === clientWidth`，无页面横向溢出；浏览器 error 日志为空。验收后已关闭本机服务并删除一次性数据库和仓库目录。

## 6. 安全与外部验收边界

自动化和浏览器验收只操作测试用临时仓库，未写入当前项目仓库或任何企业真实仓库。Push/Pull 的远端拓扑由本地裸仓库和协作者仓库构造，不需要网络凭证。企业发布前仍需在用户明确指定、允许丢弃的 14 仓 UAT 集合复跑批次密集信息、代理环境和超时恢复；该外部复跑不影响本增量四项 Git 需求的本地功能与安全验收结论。
