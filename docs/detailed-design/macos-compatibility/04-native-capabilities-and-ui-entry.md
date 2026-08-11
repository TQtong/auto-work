# 04 原生能力与页面入口

## 1. 目标

本章定义 macOS 原生用户直接感知的能力：目录选择、Excel 导入入口、季度制品下载和现有 Git 页面。原则是优先复用跨平台业务逻辑，只为确实需要操作系统参与的步骤增加受控适配器。

## 2. macOS 目录选择器

### 2.1 调用方式

macOS 原生适配器执行固定系统命令：

```text
/usr/bin/osascript -l AppleScript -e <固定脚本>
```

脚本通过 Standard Additions 调用 `choose folder`，输出所选目录的 POSIX 路径。不得把用户输入拼接进脚本文本或命令行。初始目录只通过 `AUTO_WORK_PICKER_INITIAL_PATH` 子进程环境变量传递。

### 2.2 子进程边界

- `shell: false`，固定可执行文件和参数数组。
- 继承最小必要环境：`HOME`、`TMPDIR`、`PATH` 的固定系统值及初始路径变量。
- 最长等待 10 分钟，与 Windows 选择器一致。
- stdout 上限 4096 bytes，stderr 只保留脱敏后的短摘要。
- 用户取消对应 AppleScript 用户取消错误，转换为 `{status:'cancelled', path:null}`。
- 超时终止子进程并返回 `DIRECTORY_PICKER_TIMEOUT`。

### 2.3 结果校验

输出必须：

1. 是 UTF-8 单行文本；
2. 不含 NUL、CR 或 LF；
3. 是绝对路径；
4. 能通过 `realpath`；
5. 当前进程可访问且为目录。

选择目录本身不立即修改应用配置或扫描仓库。页面仍展示待应用路径，由用户点击“配置并扫描”，并明确说明需要重启的配置项。

### 2.4 错误语义

| 错误码                                | HTTP | 场景                      | 页面动作                 |
| ------------------------------------- | ---: | ------------------------- | ------------------------ |
| `NATIVE_DIRECTORY_PICKER_UNAVAILABLE` |  409 | Docker 或平台无原生选择器 | 使用浏览器辅助或粘贴路径 |
| `DIRECTORY_PICKER_TIMEOUT`            |  504 | 窗口长期未响应            | 允许重新打开             |
| `DIRECTORY_PICKER_START_FAILED`       |  503 | `osascript` 无法启动      | 检查系统完整性/安装      |
| `DIRECTORY_PICKER_FAILED`             |  503 | 脚本异常                  | 显示关联 ID并允许重试    |
| `DIRECTORY_PICKER_RESULT_INVALID`     |  422 | 输出不是安全绝对路径      | 拒绝应用                 |
| `DIRECTORY_PICKER_RESULT_UNAVAILABLE` |  422 | 目录不存在或无权限        | 重新选择或调整权限       |

错误文案统一使用“系统目录选择窗口”，不硬编码“资源管理器”或“Windows”。

## 3. 仓库配置页面

平台能力决定按钮行为：

- `directoryPicker.mode=native`：调用现有 `/repositories/directory-picker`。
- `browser_assisted`：使用浏览器目录选择器读取目录名提示，绝不猜测绝对路径。
- `unavailable`：保留手工粘贴绝对路径，并解释当前部署边界。

占位示例按平台生成：Windows `D:/company`、macOS `/Users/alice/Projects`、Docker 宿主路径由能力端点返回平台化提示。示例不得成为默认业务路径。

## 4. Excel 导入入口

### 4.1 页面位置

在“任务与证据”页标题操作区加入“导入 Excel”按钮。按钮打开现有 `ExcelImportModal`，不新增顶级导航和路由。

页面交互：

1. 点击按钮打开弹窗并加载导入历史。
2. 用户选择单个 `.xlsx` 文件并执行现有预检。
3. 用户处理逐行 `create_excel/link_jira/skip` 决议。
4. 提交时继续要求 preview version、row version、警告确认和 Idempotency-Key。
5. 成功后关闭或保留结果视图，并刷新：
   - `tasks`
   - `task-detail`
   - `task-evidence`
   - `evidence-catalog`
   - `excel-imports`
6. 失败时保留当前决议和导入详情，不清空用户操作。

### 4.2 可访问性

- 按钮具有文本和图标，不只使用图标。
- 弹窗打开后焦点进入标题或文件选择控件；关闭后回到触发按钮。
- 行冲突、阻断和警告不能只依赖颜色。
- 表格编辑、保存和提交均可键盘完成。

### 4.3 平台关系

Excel 文件由浏览器上传到现有 API，Node 端用 ExcelJS 解析，不依赖本机 Microsoft Excel、Numbers、COM 或 AppleScript。因此入口接通后四种部署形态共享相同行为。

## 5. 季度绩效制品下载

现有受控下载端点继续是唯一文件交付方式：

- 只有 `status=succeeded`、`qaStatus=passed`、文件存在且哈希匹配时可下载。
- 使用 `Content-Disposition` 的 ASCII fallback 与 UTF-8 `filename*`。
- `.xlsx` 和 `.docx` 返回正确 MIME、`Content-Length` 和 `nosniff`。
- 页面使用 Blob URL 触发用户下载并立即释放临时 URL。

Safari/Chrome 验收必须验证中文文件名、空格、重复下载和大文件。浏览器下载完成后由用户选择 Excel/Numbers 或 Word/Pages 打开；服务端不提供任意本机路径打开接口，避免 Web 请求变成通用进程启动能力。

## 6. Git 页面与运行边界

### 6.1 页面范围

本项目保持当前“分支管理”页面：

- 查询本地与远端分支；
- 从指定基线跨仓库创建本地分支；
- 删除非当前本地分支；
- 展示逐仓和逐分支结果。

不在本次新增 fetch、pull、checkout、push、stash、stage、commit 的页面入口。后端已有动作继续保留并通过安全测试。

### 6.2 macOS Git 执行

- 使用 PATH 中的 `git`，启动时通过健康检查记录版本。
- 命令保持 `shell:false`、参数数组、固定动作和非交互环境。
- 删除 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、AskPass 和外部配置注入变量。
- 保留每仓精确 `safe.directory`，不得配置 `*`。
- 远端凭据依赖当前用户既有 Git credential helper；应用不弹终端交互窗口。
- 失败输出脱敏，禁止保存 URL 中的用户名、Token 或密码。

### 6.3 macOS 文件系统差异

- 路径边界不使用无条件小写比较。
- 仓库 identity 优先使用规范远端和 Git 目录事实，不只使用路径文本。
- 符号链接一级目录默认跳过；已登记路径每次写前重新校验。
- 测试同时覆盖默认大小写不敏感 APFS 的名称冲突和大小写敏感卷。

## 7. 能力驱动的页面状态

| 能力状态              | 目录按钮        | 钉钉测试/提交      | Excel 导入 | Git 页面        |
| --------------------- | --------------- | ------------------ | ---------- | --------------- |
| `supported`           | 启用            | 启用               | 启用       | 启用            |
| `permission_required` | 目录不受影响    | 禁用并显示授权卡片 | 启用       | 启用            |
| `offline`             | 目录不受影响    | 禁用并允许重新探测 | 启用       | 依 Git 健康状态 |
| `degraded`            | 提供手工路径    | 仅允许明确安全降级 | 启用       | 只读或逐项提示  |
| `unavailable`         | 浏览器辅助/手工 | 隐藏桌面提交       | 启用       | 依 Git 健康状态 |

前端不能根据字符串包含“Mac”或“Windows”决定行为。所有能力均来自服务端能力端点和具体操作响应。

## 8. 页面文案规则

- “当前 Windows 用户”改为“当前本机用户”；平台专属帮助中才显示 Windows 或 macOS。
- “Windows 钉钉桌面任务”改为“钉钉桌面任务”。
- “Windows 桥接”改为“桌面桥接”，详情中显示适配器平台。
- “资源管理器地址栏”按能力切换为 Finder/资源管理器说明。
- 错误提示必须包含用户下一步，不展示底层 `spawn ENOENT` 作为主文案。
