# 08 HTTP API 契约

## 1. 协议约定

### 1.1 基础

- Base path：`/api`；版本通过 `/api/v1` 或媒体类型在实现前统一确定，首版不得无版本演进。
- Content-Type：JSON 请求/响应为 `application/json; charset=utf-8`；文件上传使用 multipart，仅限明确端点。
- 时间点：UTC ISO-8601；业务日期：`YYYY-MM-DD`；时区字段使用 IANA 名称。
- ID：客户端视为不透明字符串；不得依赖 UUID 格式或外部 ID。
- 写请求必须同源、带 CSRF 令牌；产生可重复业务结果的端点带 `Idempotency-Key`。
- 所有响应带 `X-Correlation-Id`；客户端可提供合法请求 ID，服务端最终决定关联 ID。

### 1.2 成功响应

单资源：`data` + 可选 `meta`。列表：`data[]` + `page`（cursor/nextCursor/hasMore）+ `meta`。异步操作返回 202、operation/job 资源和状态查询地址；已同步完成可返回 200/201。

### 1.3 错误响应

统一错误包含：

| 字段            | 说明                                               |
| --------------- | -------------------------------------------------- |
| code            | 稳定机器码，如 `GIT_PREVIEW_STALE`                 |
| message         | 可面向用户的简要中文，不含秘密                     |
| details         | 字段错误、目标项结果等结构化信息                   |
| correlationId   | 排障关联 ID                                        |
| retryable       | 是否可安全重试                                     |
| suggestedAction | `refresh/reconfigure/reconfirm/manual_review/none` |

HTTP 语义：400 格式/规则、401 本机会话、403 安全策略、404 资源、409 状态/并发/幂等冲突、412 预检或版本前置条件、422 可解析但业务校验失败、429 限频、502 外部无效响应、503 外部/本机依赖不可用、504 超时。

### 1.4 并发控制

可编辑资源返回 `version` 和 ETag；PUT/PATCH 使用 `If-Match` 或 body version。冲突返回当前版本摘要，不做 last-write-wins。不可变版本资源无更新端点。

### 1.5 幂等

下列端点必须使用 `Idempotency-Key`：Git 批准、导入提交、周报确认/正式提交/通知、季度确认/导出、机器人测试。服务端保存 key + actor + route + 规范请求哈希 + 结果；相同 key 不同 body 返回 409，相同 body 返回首次结果。

### 1.6 分页与筛选

内部列表优先 cursor，默认 50、最大 200。排序字段白名单化。搜索文字长度受限并转义；外部 JQL 只在 Jira 专门端点中通过 schema 校验。分页响应显示数据 asOf 时间。

## 2. 会话、设置和运行状态

| 方法与路径                    | 用途           | 关键输入/输出                        |
| ----------------------------- | -------------- | ------------------------------------ |
| GET `/session`                | 当前本机会话   | 用户 SID 摘要、时区、CSRF 状态       |
| GET `/settings/profile`       | 用户与身份     | 工作时长、Git/Jira 别名、工作日历    |
| PUT `/settings/profile`       | 更新非敏感设置 | version、字段变更；写审计            |
| GET `/health`                 | 页面健康摘要   | db/worker/scheduler 状态；不泄漏凭证 |
| GET `/operations/:id`         | 异步任务状态   | progress、逐项结果、错误、可取消性   |
| POST `/operations/:id/cancel` | 请求取消       | 仅尚未完成且允许取消的任务           |

## 3. 集成配置

### 3.1 通用资源

| 方法与路径                            | 说明                                     |
| ------------------------------------- | ---------------------------------------- |
| GET `/integrations`                   | 列出连接、掩码、状态、能力、上次测试     |
| POST `/integrations`                  | 创建配置；秘密字段只在此请求传入且不回显 |
| PUT `/integrations/:id`               | 更新非敏感配置或替换凭证；需 version     |
| POST `/integrations/:id/test`         | 连接与能力探测，返回 operation           |
| POST `/integrations/:id/disable`      | 禁用连接，不删历史                       |
| DELETE `/integrations/:id/credential` | 撤销本地密钥并使连接 invalid，需确认     |

专门兼容路由 `/integrations/gitlab/test`、`/integrations/jira/test` 可保留为前端便利入口，但应委托同一 use case，避免两套语义。

### 3.2 Jira 映射

- GET `/integrations/:id/jira/fields`：字段发现结果和样例。
- POST `/integrations/:id/jira/mappings/validate`：验证候选映射，不保存。
- POST `/integrations/:id/jira/mappings`：保存新版本。
- GET `/integrations/:id/jira/mappings`：历史版本和当前版本。
- POST `/integrations/:id/jira/sync`：输入 scope（default/weekly/quarter/custom）、日期/JQL 配置，返回 sync operation。

### 3.3 钉钉模板和机器人

- GET `/integrations/:id/dingtalk/templates?name=...`：模板候选。
- POST `/integrations/:id/dingtalk/template-mappings/validate`：检查六字段映射。
- POST `/integrations/:id/dingtalk/template-mappings`：保存映射版本。
- POST `/integrations/:id/dingtalk-robot/test`：固定测试消息；需幂等键和显式确认标志。

## 4. 项目与仓库

### 4.1 发现和登记

**POST `/projects/discover`**

- 输入：可选 root（首版只能等于允许根）、includeMissingCheck。
- 输出：202 operation。
- 结果：候选仓库、匹配的已有仓库、GitLab 候选、警告/阻断。
- 副作用：只登记 discovered 观测；不会自动白名单确认。

**POST `/repositories/:id/confirm`**

- 输入：displayName、alias、projectId、remoteName、baselineBranch、发现快照版本。
- 规则：路径和 identity 仍一致；GitLab 候选可空。
- 输出：confirmed repository。

### 4.2 查询与刷新

| 方法与路径                            | 说明                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| GET `/projects`                       | 项目摘要，可按 archived/status 过滤                                                          |
| GET `/projects/:id`                   | 项目、仓库、任务摘要                                                                         |
| GET `/repositories`                   | 仓库中心读模型                                                                               |
| GET `/repositories/discovery-config`  | 扫描根目录只读状态：宿主机/运行时路径、访问性、一级目录、Git 候选数、目录选择能力和重启要求  |
| POST `/repositories/directory-picker` | 仅 Windows 本机进程打开原生目录窗口；返回 selected/绝对路径或 cancelled，Docker 返回稳定 409 |
| GET `/repositories/:id`               | 仓库、本地/GitLab 状态、刷新时间                                                             |
| POST `/repositories/:id/sync`         | 刷新本地与可用远端元数据；202                                                                |
| POST `/repositories/sync`             | 批量只读刷新；202                                                                            |
| PUT `/repositories/:id`               | 更新别名、项目、基线等；需 version                                                           |
| POST `/repositories/:id/disable`      | 移出可写白名单但保留历史                                                                     |

## 5. Git 批次

### 5.1 创建预检

**POST `/git/batches/preview`**

输入：

- `action`：固定动作枚举。
- `repositoryIds`：去重后的内部 ID，至少 1。
- `parameters`：由 action 对应的判别式 schema 校验。
- `clientContext`：可选页面来源，不参与执行。

输出 202 operation；预检完成后生成 batch。不能输入 raw command、cwd 或额外 args。

### 5.2 查看和批准

- GET `/git/batches/:id`：批次状态、参数、过期、单仓库预检/结果；输出命令仅展示。
- POST `/git/batches/:id/approve`：输入 batchVersion、selectedItemIds、acknowledgedWarningIds、确认短语/布尔值；需幂等键。返回 202 执行 operation。
- POST `/git/batches/:id/cancel`：只取消未开始项。

批准错误：`GIT_BATCH_EXPIRED`、`GIT_PREVIEW_STALE`、`GIT_ITEM_NOT_EXECUTABLE`、`GIT_WARNING_NOT_ACKNOWLEDGED`、`GIT_BATCH_STATE_CONFLICT`。

## 6. 任务、导入和证据

### 6.1 任务

- GET `/tasks`：筛选 project/status/source/sprint/date/evidenceState/currentUser；cursor。
- GET `/tasks/:id`：规范字段、逐字段来源、状态观测、证据和报告引用。
- GET `/tasks/conflicts`：Jira/Excel/人工冲突。
- PUT `/tasks/:id/overrides`：仅本地手工覆盖，字段白名单、原因、有效期、version；不能修改 Jira。

### 6.2 Excel 导入

**POST `/task-imports/preview`**：multipart 文件 + 导入策略版本；限制大小，返回 202。服务端不把原路径作为可信数据。

**GET `/task-imports/:id`**：文件哈希、工作表统计、行分页、错误分级、默认动作和匹配候选。

**PUT `/task-imports/:id/resolutions`**：保存本次预检的冲突选择/单元格修正，需 version；每次变更重新校验受影响行。

**POST `/task-imports/:id/commit`**：输入 previewVersion、acknowledgedWarnings；需幂等键。若文件哈希、规则或预检变化返回 412。

### 6.3 证据

- GET `/tasks/:id/evidence`：confirmed/suggested/rejected/expired。
- POST `/evidence-links/:id/confirm`：确认建议，需幂等键。
- POST `/evidence-links/:id/reject`：输入原因，可撤销。
- POST `/evidence-links`：创建人工关系，输入 target、evidence 和说明。
- DELETE `/evidence-links/:id/confirmation`：撤销人工决定，实际保留历史事件。

## 7. 周报

### 7.1 生成和查询

**POST `/weekly-reports/generate`**

- 输入：periodStart/end、reportDate、source freshness policy、includeUnconfirmedEvidence、AI provider（可空）、manual inputs。
- 结果：202；生成 report + source snapshot + initial version。
- 若同周期已有报告，默认返回冲突/已有报告，不静默覆盖；可明确生成新版本。

- GET `/weekly-reports`：按周期/状态。
- GET `/weekly-reports/:id`：聚合状态、当前/确认版本、交付结果。
- GET `/weekly-reports/:id/versions`：版本摘要。
- GET `/weekly-reports/:id/versions/:versionId`：六字段、来源链接、change summary。

### 7.2 编辑和 AI 重写

- PUT `/weekly-reports/:id`：输入 baseVersion、六字段或提交元数据；自动产生 manual version，不原地覆盖。
- POST `/weekly-reports/:id/generate-field`：字段/块级 AI，输入 baseVersion、purpose、instructions（长度与安全校验）；202，返回新建议版本或候选，不自动成为当前人工版本。
- POST `/weekly-reports/:id/versions/:versionId/restore`：从历史创建新版本。

### 7.3 确认和交付

- POST `/weekly-reports/:id/confirm`：versionId、templateMappingVersion、warnings acknowledgements；幂等。
- POST `/weekly-reports/:id/submit-log`：confirmedVersionId、recipient snapshot；幂等。返回 202 delivery intent。
- POST `/weekly-reports/:id/resolve-unknown`：触发查询/记录人工核对，不允许直接“标成功”无依据。
- POST `/weekly-reports/:id/notify-group`：仅在日志成功后；幂等，输入通知类型。
- POST `/weekly-reports/:id/retry-notification`：只重试机器人。
- POST `/weekly-reports/:id/export-copy`：生成降级复制文本，明确 `submitted=false`。

## 8. 季度绩效

### 8.1 Review 与收集

- POST `/quarterly-reviews`：创建自然/自定义季度。
- GET `/quarterly-reviews/:id`：状态、完整性、当前版本。
- POST `/quarterly-reviews/:id/collect`：选择来源 freshness policy；202。
- GET `/quarterly-reviews/:id/achievements`：候选池筛选和分页。

### 8.2 成果和指标

- PUT `/quarterly-reviews/:id/achievements`：批量选择/排除/排序需 baseVersion；逐项动作有 reason。
- POST `/quarterly-reviews/:id/achievements`：人工成果。
- PUT `/achievements/:id`：编辑结构化内容，version。
- POST `/achievements/:id/evidence`：添加证据。
- PUT `/quarterly-reviews/:id/metric-template`：绑定已存在模板版本；不能原地改模板。
- PUT `/quarterly-reviews/:id/scores`：逐指标用户分和理由，服务端计算加权值。

### 8.3 生成、确认和导出

- POST `/quarterly-reviews/:id/generate`：生成成果表述/自评/分数建议，purpose 必填；202。
- PUT `/quarterly-reviews/:id/narrative`：从 base version 创建人工版本。
- POST `/quarterly-reviews/:id/confirm`：锁定成果、指标、分数和 narrative 快照；幂等。
- POST `/quarterly-reviews/:id/export`：format xlsx/docx、templateVersion、confirmedSnapshot；幂等，202。
- GET `/exports/:id`：状态、文件名、哈希、大小。
- GET `/exports/:id/content`：同源下载；Content-Disposition 安全文件名。

## 9. 作业、审计与诊断

- GET `/jobs`：类型/状态/时间筛选，只展示非敏感 payload 摘要。
- POST `/jobs/:id/retry`：仅 retryable 且不扩大原批准范围。
- GET `/audit-events`：时间、动作、对象、结果筛选；默认只读。
- GET `/diagnostics/export`：用户确认后生成脱敏诊断包，列出将包含的文件；绝不含密钥、Webhook、完整正文或源码。
- POST `/maintenance/backup`：手动一致备份；202。
- GET `/backups`、POST `/backups/:id/verify`：查看/校验；恢复流程需停服并单独确认，不走普通 API。

## 10. 事件更新

首版可用短轮询 operation；如采用 SSE，仅发送 operation progress、缓存刷新和状态变更，不发送凭证或完整外部响应。断线后客户端以 last event ID/资源 GET 恢复，SSE 不是事实源。

## 11. API 安全测试要求

- 所有 IDOR：即使单用户也验证资源类型/归属和不可猜测路径。
- 参数污染、未知字段、超长文本、Unicode/控制字符、文件名/路径、URL SSRF。
- 幂等 key 重放和同 key 异 body。
- If-Match 冲突、状态机越级、重复批准、确认后修改。
- raw command、force、reset、任意 JQL/URL 越权表达不可进入执行层。
- 错误和审计响应秘密扫描。
