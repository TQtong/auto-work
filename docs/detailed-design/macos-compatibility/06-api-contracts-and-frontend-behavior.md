# 06 API 契约与前端行为

## 1. 通用约定

本章是现有 [HTTP API 契约](../08-http-api-contracts.md) 的增量。统一响应 envelope、CSRF、同源校验、关联 ID、幂等和错误结构保持不变。

前端必须以服务端报告的运行平台和能力为准。浏览器可能运行在与 API 不同的平台，特别是 Docker 场景，因此禁止使用 `navigator.platform` 或 User-Agent 选择后端能力。

## 2. 平台能力端点

### 2.1 `GET /api/v1/platform/capabilities`

用途：返回不含秘密的平台事实与动态原生能力状态。端点只读，不要求 CSRF，可由页面每 15 秒轮询；服务端可对静态事实缓存，对桥接状态按最新心跳计算。

响应：

```json
{
  "data": {
    "platform": "darwin",
    "architecture": "arm64",
    "deploymentMode": "native",
    "minimumSupportedVersion": "13.0",
    "directoryPicker": {
      "mode": "native",
      "status": "supported"
    },
    "credentialVault": {
      "backend": "sealed",
      "status": "supported"
    },
    "git": {
      "status": "supported",
      "executable": "git",
      "version": "2.x"
    },
    "desktopAutomation": {
      "status": "permission_required",
      "adapter": "macos_ax_vision",
      "bridgeVersion": "0.1.0",
      "heartbeatAt": "2026-08-10T08:00:00.000Z",
      "client": {
        "running": true,
        "loggedIn": "unknown"
      },
      "permissions": {
        "accessibility": "granted",
        "screenRecording": "denied",
        "automation": "unknown"
      }
    }
  },
  "meta": {
    "asOf": "2026-08-10T08:00:03.000Z",
    "correlationId": "..."
  }
}
```

约束：

- `platform`：`win32 | darwin | linux`。
- `architecture`：Node 运行架构，正式 Mac 包只允许 `arm64 | x64`。
- `deploymentMode`：`native | docker`。
- 能力状态：`supported | unavailable | permission_required | offline | degraded`。
- 不返回绝对目录、用户名、UID、SID、桥接 PID、Bundle 路径或签名证书详情。
- Git executable 仅返回逻辑名，不返回解析后的绝对安装路径。

### 2.2 缓存和失败

- 静态平台事实可在进程生命周期缓存。
- 桥接心跳超过 15 秒即视为 offline。
- 读取心跳失败只使桌面能力 offline，不使整个端点失败。
- Git 健康检查失败返回 degraded/unavailable 和稳定原因码，不回显原始 stderr。

## 3. 会话契约

### 3.1 新响应

`GET /api/v1/session` 的用户部分调整为：

```json
{
  "profileId": "opaque-id",
  "platform": "darwin",
  "architecture": "arm64",
  "identitySummary": "macOS UID 501",
  "displayName": "alice",
  "timezone": "Asia/Shanghai",
  "csrfToken": "..."
}
```

### 3.2 兼容字段

第一个兼容版本在 Windows 响应中继续返回：

```json
{ "windowsSidSummary": "S-1-5-…1001" }
```

- macOS 和 Linux 不返回该字段。
- 前端必须改用 `identitySummary`。
- 类型定义把旧字段标记为 optional/deprecated。
- 下一个破坏性 API 版本删除旧字段。

## 4. 目录选择契约

### 4.1 请求

保留现有端点：

```http
POST /api/v1/repositories/directory-picker
Content-Type: application/json

{"initialPath":"/Users/alice/Projects"}
```

请求继续执行同源、CSRF 和长度校验。`initialPath` 可省略；它只作为窗口初始目录，不改变扫描白名单。

### 4.2 响应

选择：

```json
{ "data": { "status": "selected", "path": "/Users/alice/Projects" } }
```

取消：

```json
{ "data": { "status": "cancelled", "path": null } }
```

Docker 中调用保持 409 `NATIVE_DIRECTORY_PICKER_UNAVAILABLE`。错误消息改为平台中立文案。

## 5. 钉钉能力探测

### 5.1 平台预检

创建或测试 `dingtalk_desktop` 连接前，后端先检查平台能力：

- `permission_required`：返回 409，不创建外部测试作业；
- `offline`：返回 503、`retryable=true`；
- `degraded`：返回具体阻断原因；
- `supported`：继续现有连接 probe。

### 5.2 探测结果扩展

```json
{
  "adapter": "macos_ax_vision",
  "platform": "darwin",
  "bridgeStatus": "supported",
  "client": {
    "running": true,
    "loggedIn": true
  },
  "permissions": {
    "accessibility": "granted",
    "screenRecording": "granted",
    "automation": "granted"
  },
  "organizationVisible": true,
  "templateVisible": true,
  "recipientVisible": true,
  "observedFields": ["汇报日期", "近期目标", "本周工作", "下周计划", "问题与风险", "其他"]
}
```

probe 可以导航和识别页面，但不得填写正式正文或点击提交；若钉钉自身产生空草稿，页面需要在测试前明确提示。

### 5.3 周报提交

正式提交端点保持既有 delivery intent、confirmation 和 Idempotency-Key 契约。新增规则：

1. 排队前读取平台能力和新鲜心跳。
2. 执行前再次检查权限、屏幕锁定和桥接 ID。
3. 桥接返回 unknown 时 delivery intent 进入 `unknown`，不进入自动重试队列。
4. 人工裁决继续使用既有恢复工作流，必须记录审计。

## 6. Excel 导入页面行为

### 6.1 打开与加载

- “任务与证据”页标题区展示“导入 Excel”。
- 打开弹窗时查询 `/api/v1/excel-imports`。
- 已有导入可从历史列表继续查看，不需要新增路由。
- 页面刷新后弹窗关闭，但历史预检和决议仍来自后端持久化。

### 6.2 提交后的查询失效

导入成功后统一刷新：

```text
excel-imports
excel-import-detail:<id>
tasks
task-detail:*
task-evidence:*
evidence-catalog
dashboard-summary
```

前端只使 React Query 缓存失效，不在本地模拟任务或证据合并。

### 6.3 错误保持

- 预检 4xx：保留文件名和错误，允许重新选择文件。
- 决议保存 412：刷新详情，突出已过期行，不静默覆盖。
- commit 412：保留决议并要求重新预检/确认。
- 网络失败：允许使用相同 Idempotency-Key 查询首次结果，不生成重复任务。

## 7. 前端平台行为

### 7.1 应用外壳

- 用户区展示 `identitySummary`，不再固定展示 SID。
- 设置页增加“本机平台能力”卡片，展示平台、架构、部署形态和简化状态。
- 动态能力每 15 秒刷新；窗口获得焦点时立即刷新一次。

### 7.2 macOS 权限卡片

当桌面自动化为 `permission_required` 时，设置页显示：

- 缺失权限列表；
- 系统设置路径；
- “重新检查”按钮；
- 为什么需要该权限以及只访问钉钉窗口的说明；
- “暂不使用桌面提交”选项，不阻断其他功能。

页面不声称可以通过 Web 直接授予权限，也不重复自动弹出系统窗口。

### 7.3 周报提交按钮

| 状态                  | 行为                                |
| --------------------- | ----------------------------------- |
| `supported`           | 正常执行提交前确认                  |
| `permission_required` | 禁用，链接到授权卡片                |
| `offline`             | 禁用，提示启动桥接/钉钉并允许刷新   |
| `degraded`            | 禁用，展示具体错误码和人工复制/导出 |
| `unavailable`         | 不显示桌面提交，保留其他已配置通道  |

## 8. 新增错误码

| 错误码                                 | HTTP | retryable | suggestedAction |
| -------------------------------------- | ---: | --------: | --------------- |
| `PLATFORM_CAPABILITY_UNAVAILABLE`      |  409 |     false | `reconfigure`   |
| `LOCAL_IDENTITY_UNAVAILABLE`           |  503 |      true | `manual_review` |
| `LOCAL_IDENTITY_INVALID`               |  503 |     false | `reconfigure`   |
| `MACOS_VERSION_UNSUPPORTED`            |  503 |     false | `reconfigure`   |
| `DIRECTORY_PICKER_TIMEOUT`             |  504 |      true | `none`          |
| `DIRECTORY_PICKER_START_FAILED`        |  503 |      true | `reconfigure`   |
| `DIRECTORY_PICKER_RESULT_INVALID`      |  422 |     false | `reconfigure`   |
| `DINGTALK_DESKTOP_PERMISSION_REQUIRED` |  409 |      true | `reconfigure`   |
| `DINGTALK_DESKTOP_SESSION_LOCKED`      |  409 |      true | `none`          |
| `DINGTALK_DESKTOP_CLIENT_NOT_RUNNING`  |  503 |      true | `none`          |
| `DINGTALK_DESKTOP_NOT_LOGGED_IN`       |  409 |      true | `reconfigure`   |
| `DINGTALK_DESKTOP_UI_CHANGED`          |  409 |     false | `manual_review` |
| `DINGTALK_DESKTOP_REQUEST_IN_PROGRESS` |  409 |      true | `none`          |
| `DINGTALK_DESKTOP_REQUEST_EXPIRED`     |  409 |      true | `refresh`       |

`DINGTALK_DESKTOP_SUBMISSION_RESULT_UNKNOWN` 沿用现有语义：HTTP/作业结果可表达失败，但 `retryable=false`、`suggestedAction=manual_review`。

## 9. 文案和可访问性

- 所有平台状态同时包含图标、文字和颜色。
- 错误提示先说明影响，再说明用户动作，关联 ID 放在详情中。
- macOS 权限名称采用系统设置中的正式中文名称。
- 外部链接或打开系统设置的操作必须由用户点击触发。
- 弹窗和授权卡片满足键盘焦点、语义标题和屏幕阅读器描述。
- “桌面回执”明确标记为本地自动化回执，不显示成“钉钉日志 ID”。

## 10. 审计与隐私

平台能力读取不单独写高频审计事件；状态变化才写应用事件。以下操作必须审计：

- 本机身份迁移和资料接管；
- 钉钉权限从不可用变为可用的连接验证；
- 桥接 probe、submit、unknown 和人工裁决；
- Excel 导入 commit；
- 季度制品下载。

审计只保存平台、适配器、状态、错误码和资源 ID，不保存 UID/SID 全值、周报正文、截图内容、路径或凭据。
