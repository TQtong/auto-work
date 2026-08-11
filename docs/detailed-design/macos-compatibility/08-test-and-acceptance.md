# 08 测试与验收

## 1. 质量目标

macOS 兼容验收必须证明功能、安全和恢复语义与 Windows 一致，而不是只证明代码能在 Darwin 编译。所有平台差异必须有自动化契约；钉钉 UI 自动化必须额外通过目标版本真实 UAT。

## 2. 平台门禁矩阵

| 门禁                  | Windows 原生 | macOS Intel | macOS Apple Silicon | Linux Docker |
| --------------------- | -----------: | ----------: | ------------------: | -----------: |
| format/lint/typecheck |         必须 |        必须 |                必须 |         必须 |
| 单元与数据集成测试    |         必须 |        必须 |                必须 |         必须 |
| 真实临时 Git 仓库     |         必须 |        必须 |                必须 |         必须 |
| Prisma 迁移/回滚预检  |         必须 |        必须 |                必须 |         必须 |
| 本机启动/health       |         必须 |        必须 |                必须 |   容器 smoke |
| 原生目录选择契约      |      Windows |       macOS |               macOS |   浏览器辅助 |
| sealed vault          |     兼容读取 |        必须 |                必须 |         必须 |
| DPAPI                 |         必须 |      不适用 |              不适用 |       不适用 |
| 桥接协议自动化        |      Windows |       macOS |               macOS |     宿主协议 |
| 钉钉真实 UAT          |       发布前 |      发布前 |              发布前 |   依宿主平台 |
| 发布包校验            |          ZIP |      tar.gz |              tar.gz |         镜像 |

若 CI 暂时没有 Intel runner，可使用固定 Intel 测试机执行受控发布门禁；缺少该证据时不能宣称 Intel 正式支持。

## 3. 单元测试

### 3.1 平台选择

- `native + win32` 选择 SID、Windows picker、DPAPI。
- `native + darwin` 选择 UID、macOS picker、sealed、macOS bridge。
- `docker + linux` 选择 container identity、browser assisted、sealed、host bridge。
- 非 Windows 显式 `dpapi` 返回稳定配置错误。
- 生产环境禁止平台 override。

关联验收：MAC-AC-001～006、MAC-AC-044～046。

### 3.2 路径

覆盖：

- 绝对路径、相对路径、空格、中文和 Unicode 规范化形式；
- APFS 大小写敏感与不敏感策略的模拟契约；
- 根目录自身、一级子目录、二级目录和 `..`；
- 仓库目录符号链接、根目录符号链接和 `.git` worktree 文件；
- SQLite `file:` URL 正反转换；
- 导出、备份、桥接目录的边界检查。

关联验收：MAC-AC-007～010、MAC-AC-018、MAC-AC-022。

### 3.3 目录选择器

注入 fake child executor，覆盖：

- 选中合法路径；
- 用户取消；
- 超时和启动失败；
- stdout 超限；
- CR/LF/NUL、相对路径、不存在、文件而非目录；
- Docker 调用原生端点被拒绝。

CI 不弹真实交互窗口；真实窗口作为 macOS 安装 UAT。

## 4. 数据与身份迁移测试

1. 从旧 schema 构造 Windows 用户及全部主要关联表。
2. 执行生产迁移并验证：
   - `id` 不变；
   - `localIdentityKey=win32:sid:<SID>`；
   - 外键和计数不变；
   - 唯一索引有效；
   - `PRAGMA foreign_key_check` 无结果。
3. 同一 Windows SID 启动复用原资料。
4. macOS UID 首次创建、重启复用。
5. 身份读取失败不创建随机资料。
6. Windows 数据迁到 Mac 时 `dpapi:` 连接 invalid，重新配置后产生 `sealed:` 引用。
7. sealed 主密钥错误、权限过宽、篡改和丢失均被拒绝。

关联验收：MAC-AC-004～006、MAC-AC-041～043。

## 5. Git 真实仓库测试

取消仅在 Windows 运行的限制，在每个平台临时目录创建普通仓库与裸远端。覆盖：

- clean、dirty、staged、untracked、conflict、detached、unborn；
- 本地/远端分支查询、中文提交信息和空格路径；
- 跨仓创建分支、已存在分支和部分失败；
- 当前分支拒绝删除、OID 改变拒绝删除；
- fetch、ff-only pull、checkout、push、stash、stage、commit 引擎契约；
- 预检后 HEAD/index/worktree/remote 变化；
- hook 失败、输出超限、超时和非交互凭据失败；
- 符号链接替换、路径大小写冲突和 identity 变化；
- 参数注入、前导短横线 ref/path 和凭据输出脱敏。

所有仓库均位于测试临时根；禁止读取真实用户仓库和 credential helper 中的秘密。

关联验收：MAC-AC-014～019、MAC-AC-047。

## 6. 前端与文件测试

### 6.1 Excel 入口

- 任务页按钮可见并可键盘触发。
- 打开时加载导入历史。
- 上传合法/非法 `.xlsx`、预检、逐行决议和 commit。
- 成功后任务、详情、证据和导入历史刷新。
- 412 和网络失败时保留用户决议。
- 弹窗焦点进入和返回正确。

关联验收：MAC-AC-011～013。

### 6.2 季度下载

在 Safari 和 Chrome 验证：

- 中文、空格和重复文件名；
- `.xlsx/.docx` MIME 和扩展名；
- `Content-Length`、下载后哈希和 QA 状态；
- 未完成、缺失、篡改制品被拒绝；
- Excel/Numbers、Word/Pages 能打开并保持中文内容。

关联验收：MAC-AC-020～022。

### 6.3 能力 UI

- 使用服务端 mock 覆盖五种能力状态。
- 浏览器平台与服务端平台不同仍展示正确行为。
- 权限状态变化后轮询和窗口聚焦刷新。
- 禁用按钮、错误提示、授权说明和人工降级均可访问。

关联验收：MAC-AC-001～003、MAC-AC-023～024。

## 7. 桥接协议自动化

不启动真实钉钉，使用 fake bridge/AX/Vision 驱动覆盖：

- v2 心跳完整、过期、未来时间、schema 错误和两个活跃 bridge ID；
- 请求原子认领、过期、输出超限和未知字段；
- 响应 requestId/runId 不匹配；
- `runId` succeeded/unknown/failed/in-progress 去重；
- 崩溃发生在点击前、标记点击后、点击后等待成功期间；
- Accessibility 优先、Vision 兜底和 OCR 置信度不足；
- 六字段缺失、回读不一致、公司/模板/群不匹配；
- 截图路径越界和证据写失败；
- 剪贴板恢复、外部 changeCount 变化和异常清理；
- 日志、心跳、回执不存在正文和敏感路径。

关联验收：MAC-AC-023～035。

## 8. 钉钉真实 UAT

### 8.1 前置条件

- 独立测试钉钉账号、公司、日志模板和接收群。
- 模板包含设计中的六字段，测试内容显眼标注“自动化 UAT”。
- 目标 macOS 13+ Intel 和 Apple Silicon 各至少一台。
- 记录钉钉版本、显示缩放、语言和权限状态。
- 正式群或真实周报不得用于自动化探索。

### 8.2 场景

| 场景                       | 期望                              |
| -------------------------- | --------------------------------- |
| 三类权限全部拒绝           | probe 前阻断，页面给出授权引导    |
| 只缺屏幕录制               | 不允许正式提交                    |
| 钉钉未启动                 | offline，可安全重试探测           |
| 钉钉未登录                 | failed，不填写字段                |
| 屏幕锁定/切换用户          | 点击前阻断                        |
| 多个钉钉窗口               | 冲突，不猜主窗口                  |
| 公司不匹配                 | failed，不导航到提交              |
| 模板不匹配                 | failed，不填写                    |
| 六字段少一个               | failed，不填写                    |
| 字段内容含中文、换行、符号 | 填写和回读一致                    |
| 群名不匹配/同名            | failed，不提交                    |
| 正常提交                   | succeeded、单条日志、前后证据完整 |
| 点击后隐藏成功提示         | unknown，禁止重试                 |
| 重发相同 runId             | 返回原回执，不再次点击            |
| 桥接在点击后崩溃           | 重启后 unknown，不继续执行        |
| 钉钉升级导致 UI 改变       | degraded，阻断提交并要求重新 UAT  |

每次成功 UAT 都要人工在钉钉日志列表核对唯一性；该人工事实只作为测试证据，不改变产品运行时不能查询列表的边界。

关联验收：MAC-AC-023～035、MAC-AC-048。

## 9. macOS CI

CI job 顺序：

1. 冻结安装依赖。
2. format check、lint、typecheck。
3. 单元和数据集成测试。
4. Prisma validate、从空库 deploy、status。
5. 构建 API/Web/共享包。
6. 执行真实临时 Git 仓库矩阵。
7. 生产配置启动 API，检查 session、capabilities、health 和 loopback。
8. 构建两架构桥接并执行无 UI 协议测试。
9. 生成 macOS 发布包、SBOM、SHA256SUMS 和 manifest。
10. 校验架构、签名/公证状态字段和包内链接。

PR 可使用 ad-hoc 签名验证结构；受保护 release job 才可访问签名和公证凭据。任何秘密不得输出到构建日志或上传到普通测试制品。

## 10. 发布阻断

以下任一项失败即阻断 macOS 正式发布：

- MAC-AC-001～049 中适用于本次版本的条目未通过或无证据；
- Intel 或 Apple Silicon 任一声明架构没有门禁结果；
- 桥接未使用稳定签名/公证；
- 真实钉钉 UAT 未覆盖成功、unknown 和重复 runId；
- Windows 或 Linux Docker 回归失败；
- 数据迁移/回滚演练失败；
- 文档、错误码、能力 DTO 与实现不一致；
- 秘密扫描或制品校验失败。

## 11. 验收证据

每次候选发布保存：

- CI run 和 commit；
- 平台/架构矩阵；
- release manifest、SBOM 和校验和；
- 数据迁移与回滚报告；
- Git 测试摘要；
- 脱敏钉钉 UAT 清单和截图哈希；
- 已知限制与风险接受记录。

证据不得包含真实 Token、周报正文、完整用户名、绝对仓库路径或钉钉群成员。
