# 阶段四 B1：AI 三协议适配与真实连接测试

## 1. 本增量边界

本增量完成 OpenAI-compatible、Anthropic、Gemini 三类协议适配、真实模型连接测试、统一 usage/停止原因/请求 ID 和稳定错误转换，并补齐设置页的完整非秘密配置。状态为 `implemented`：三协议契约与失败矩阵已自动验证，但当前工作区没有用户授权的供应商测试 Key，因此没有把合成 fixture 描述为真实供应商联调成功。

白名单净化、秘密扫描、结构化引用/事实校验、AI 建议不可变版本、采纳/拒绝和规则降级属于紧接着的 04B2。完成 04B2 前，`AC-AI-01/02/03` 和 `AC-WRP-03` 均不提升为 `verified`。

## 2. 统一领域端口与协议隔离

- 领域请求只包含用途、系统约束、许可文本、输出 JSON Schema、输出上限和温度；不接受 URL、鉴权头、工具或文件。
- OpenAI-compatible 使用 Chat Completions 的 Bearer 鉴权和 `response_format.json_schema`；Anthropic 使用 `x-api-key`、固定 API 版本和 `output_config.format`；Gemini 使用 `x-goog-api-key`、`generateContent` 和 `generationConfig.responseSchema`。
- 三种请求均不发送 `tools`、`tool_config`、文件、图像或远程资源。响应出现 tool call、function call、可执行代码、截断、内容过滤、拒绝或非正常停止原因时统一拒绝，不把半截 JSON 交给领域层。
- 适配器统一输出观察到的模型、纯文本结构化结果、停止原因、供应商请求 ID，以及输入/输出/总量/缓存 Token；未知 usage 保留 `null`，不伪造为 0。

协议实现按 2026-07-18 官方资料核对：[OpenAI Chat API](https://developers.openai.com/api/reference/resources/chat)、[Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)、[Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)、[Gemini GenerateContent](https://ai.google.dev/api/generate-content)。

## 3. 外部请求安全与错误语义

- 所有 AI 地址必须是无凭证 HTTPS，配置阶段拒绝 loopback、私网和 metadata 地址；调用时重新解析 DNS、检查全部地址并固定首个允许 IP，禁止 DNS rebinding。
- 端点只从已批准 base URL 同源拼接；不跟随 3xx。请求受 512 KiB 正文、4 MiB 响应、用户配置超时和 HTTPS 证书校验约束。
- 401、403、404、429、5xx、重定向、超时、连接错误、无效 JSON、缺候选、缺正文和异常停止原因转换为稳定错误码。错误只可携带供应商 request ID，不回显供应商正文、API Key 或请求体。
- 用途必须位于连接的 `allowedPurposes`；输出上限不能超过连接上限；温度必须位于 0～1。违反本地策略时在发送前拒绝。

## 4. 真实连接测试与能力矩阵

- AI 连接测试不再因“保存了协议和模型字符串”而成功。作业会从 Windows DPAPI 保险箱读取一次性 Key，向实际配置模型发送最小合成元数据和严格 JSON Schema。
- 只有返回精确探测标记、合法 JSON、正常停止原因且协议解析成功，连接才标为 `healthy`。
- 能力矩阵冻结协议、配置/观察模型、结构化输出、usage 可见性、允许用途和快照哈希，并明确记录 `metadataOnly=true`、`toolsEnabled=false`、`fileInputEnabled=false`、`sourceCodeInputEnabled=false`。
- 缺配置为 `configuration_required`，401/403 为 `invalid`，额度、服务、输出或网络问题为 `degraded`；后续生成不能使用非健康连接。

## 5. 设置页

AI 连接表单完整暴露协议、模型、超时、最大输入 Token、最大输出 Token、固定/供应商默认温度策略、固定温度和允许用途。页面明确提示连接测试会真实调用模型，以及 AI 没有工具、源码、diff、附件或本机文件读取能力。API Key 仍只在提交瞬间进入 DPAPI，数据库和页面仅显示掩码。

## 6. 自动化验收

- 三协议正向 fixture 分别验证端点、鉴权头、结构化输出位置、无工具请求、模型、正文、usage、停止原因和 request ID。
- 负向矩阵覆盖 301、401、403、404、429、503，确保稳定分类且供应商错误正文不泄露；另覆盖工具调用、截断和未授权用途。
- 探测测试覆盖真实结构化标记、能力快照哈希、缺配置、无效凭证和供应商不可用；Web 测试覆盖所有 AI 非秘密配置与一次性 Key 的请求结构。
- 全仓 `pnpm verify` 通过：Contracts 2、Domain 28、API 122、Web 9，共 161 个测试；Prettier、ESLint、TypeScript 类型检查和 API/Web 生产构建全部成功。

## 7. 下一增量

04B2 将只从周报冻结快照构造新白名单对象，扫描并阻断秘密/源码/diff/附件内容，分配不可猜测引用 ID，校验模型的六字段、引用、数值、日期、issue key 和项目名，记录生成尝试与失败原因，创建独立 AI 建议版本并支持人工采纳/拒绝；所有失败均回退规则/当前人工版本而不阻止编辑。
