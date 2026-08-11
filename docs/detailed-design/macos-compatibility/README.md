# Auto Work macOS 兼容详细设计文档集

> 文档版本：1.0
>
> 设计基线：`docs/detailed-design` v1.0 与当前仓库实现
>
> 适用平台：macOS 13+（Intel / Apple Silicon），原生运行优先
>
> 文档状态：详细设计，实施前基线
>
> 更新日期：2026-08-10

## 1. 目标与权威关系

本目录定义 Auto Work 从“Windows 原生 + Linux Docker”扩展到 macOS 的增量设计。业务规则、领域状态机、幂等、安全边界和已有 HTTP 契约仍以父目录文档为通用基线；当父目录中的 Windows 专属描述与本目录冲突时：

1. macOS 和跨平台实现以本目录为准；
2. Windows 现有行为继续以父目录及 Windows 运维文档为准；
3. 业务安全边界不得因平台兼容而降低；
4. 若实现条件变化，必须先更新本目录的 ADR、风险和验收追踪，再修改代码。

本项目仍是当前操作系统用户使用的单用户本机工作台，只允许回环地址访问，不因增加 macOS 支持而变成远程服务或多人系统。

## 2. 支持目标

- macOS 13 Ventura 及以上。
- Apple Silicon `arm64` 与 Intel `x86_64`。
- macOS 原生进程作为主要交付形态，macOS Docker Desktop 作为兼容部署。
- macOS 上支持目录选择、仓库发现、现有 Git 页面、Excel 导入、季度文件下载和完整钉钉桌面日志自动提交。
- Windows 原生和 Linux Docker 现有能力不回退。

## 3. 文档导航

| 文档                                                                  | 主要内容                                 | 主要读者                |
| --------------------------------------------------------------------- | ---------------------------------------- | ----------------------- |
| [01-范围与兼容矩阵](./01-scope-and-compatibility-matrix.md)           | 需求、现状、平台能力矩阵、范围边界       | 产品、架构、测试        |
| [02-跨平台架构](./02-cross-platform-architecture.md)                  | 平台端口、适配器选择、进程与路径边界     | 架构、后端              |
| [03-身份、配置与数据迁移](./03-identity-config-and-data-migration.md) | 本机身份、目录、凭据、数据库迁移         | 后端、数据、运维        |
| [04-原生能力与页面入口](./04-native-capabilities-and-ui-entry.md)     | 目录选择、Excel 入口、文件下载、Git 页面 | 前端、后端、测试        |
| [05-macOS 钉钉桌面桥接](./05-macos-dingtalk-desktop-bridge.md)        | 桥接协议、权限、OCR、提交状态机          | macOS、后端、安全、测试 |
| [06-API 与前端行为](./06-api-contracts-and-frontend-behavior.md)      | API、DTO、错误码、页面状态               | 前端、后端、测试        |
| [07-macOS 安装与发布](./07-macos-installation-and-release.md)         | 安装、LaunchAgent、签名、公证、升级回滚  | 发布、运维              |
| [08-测试与验收](./08-test-and-acceptance.md)                          | 自动化矩阵、真实 UAT、发布门禁           | 测试、产品、开发        |
| [09-实施、风险与 ADR](./09-delivery-plan-risks-and-adrs.md)           | 工作包、依赖、风险、决策记录             | 项目经理、全体          |

## 4. 推荐阅读顺序

1. 产品和测试先读 01，确认需求与验收编号。
2. 架构和后端依次阅读 02、03、05、06。
3. 前端阅读 04、06，并以 08 建立自动化场景。
4. 发布和运维阅读 03、07、08。
5. 开始实施前由负责人确认 09 中的 ADR、风险和阶段门。

## 5. 需求追踪

| 需求                           | 设计归属 | 验收            |
| ------------------------------ | -------- | --------------- |
| MAC-REQ-001 平台识别与能力发现 | 02、06   | MAC-AC-001～003 |
| MAC-REQ-002 macOS 本机身份     | 03、06   | MAC-AC-004～006 |
| MAC-REQ-003 macOS 原生目录选择 | 04、06   | MAC-AC-007～010 |
| MAC-REQ-004 Excel 导入可达     | 04、06   | MAC-AC-011～013 |
| MAC-REQ-005 现有 Git 能力兼容  | 02、04   | MAC-AC-014～019 |
| MAC-REQ-006 季度制品下载兼容   | 04、06   | MAC-AC-020～022 |
| MAC-REQ-007 钉钉桌面完整提交   | 05、06   | MAC-AC-023～035 |
| MAC-REQ-008 macOS 安装与运维   | 07       | MAC-AC-036～043 |
| MAC-REQ-009 跨平台回归         | 08       | MAC-AC-044～049 |

完整需求、验收定义和平台能力矩阵见 [01-范围与兼容矩阵](./01-scope-and-compatibility-matrix.md)。

## 6. 共同约束

- 只监听 `127.0.0.1` / `::1`，变更请求继续执行 Host、Origin 和 CSRF 校验。
- Git 不接收 raw shell、任意 cwd 或自由参数数组；仓库必须先进入白名单。
- 钉钉正式提交继续使用不可变确认版本、提交意图、幂等键和结果未知保护。
- 平台桥接不得记录周报正文、凭证明文或剪贴板内容。
- macOS 系统权限未就绪时必须明确阻断，不允许退化为盲坐标点击。
- Excel 导入、季度导出和 HTTP 平台集成优先保持浏览器/Node 跨平台实现。

## 7. 本次明确不做

- 不开放 Git 批处理后端的 fetch、pull、checkout、push、stash、stage、commit 页面入口。
- 不提供 App Store 分发、自动更新服务或系统级守护进程。
- 不支持多用户并发、局域网访问、反向代理或移动端。
- 不用机器人消息冒充钉钉正式日志。
- 不在本阶段将 sealed vault 替换为 macOS Keychain。
