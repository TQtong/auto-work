# 03 身份、配置与数据迁移

## 1. 目标

本设计把“当前 Windows 用户”提升为“当前本机操作系统用户”，同时保证已有 Windows 数据升级后仍属于原用户。迁移不得重新创建业务资料、丢失关联记录或尝试跨平台解密 DPAPI。

## 2. 本机身份模型

### 2.1 统一结构

```ts
interface LocalIdentity {
  platform: 'win32' | 'darwin' | 'linux';
  localIdentityKey: string;
  displayName: string;
  identitySummary: string;
}
```

| 平台            | 键格式             | 来源                                   | 示例摘要         |
| --------------- | ------------------ | -------------------------------------- | ---------------- |
| Windows         | `win32:sid:<SID>`  | `whoami.exe /user`                     | `S-1-5-…1001`    |
| macOS           | `darwin:uid:<uid>` | `/usr/bin/id -u`                       | `macOS UID 501`  |
| Linux 原生/容器 | `linux:uid:<uid>`  | `process.getuid()` 或 `/usr/bin/id -u` | `Linux UID 1000` |

`localIdentityKey` 仅用于本机资料唯一性，不是登录凭据或跨机器身份。系统仍是单用户工作台，不允许客户端提交或切换该值。

### 2.2 macOS 读取规则

1. 优先调用 Node `process.getuid()`；不可用时执行固定路径 `/usr/bin/id` 参数 `-u`。
2. UID 必须是 `0..2147483647` 的十进制整数。
3. 正式用户级安装拒绝 UID 0，避免以 root 身份建立错误资料和文件所有权。
4. 显示名来自 `node:os.userInfo().username`，只用于 UI。
5. 读取失败时生产环境启动失败；开发/测试环境可以使用明确标记的 `fallback-<hash>`，健康页显示 degraded。

## 3. 数据库变更

### 3.1 目标模型

`UserProfile` 增加：

| 字段               | 类型          | 约束                  | 说明                       |
| ------------------ | ------------- | --------------------- | -------------------------- |
| `localIdentityKey` | text          | unique、not null      | 平台前缀的本机身份键       |
| `platform`         | text          | not null              | `win32/darwin/linux`       |
| `legacyWindowsSid` | text nullable | unique where not null | 一个兼容周期内保留的旧 SID |

Prisma 属性建议使用 `localIdentityKey @map("local_identity_key")`、`platform` 和 `legacyWindowsSid @map("windows_sid")`。所有外键继续引用 `UserProfile.id`，因此业务表不需要重写。

### 3.2 SQLite 迁移步骤

迁移必须在单个数据库迁移事务中完成：

1. 新建目标结构的 `user_profile_new`。
2. 从旧表复制所有行：
   - `local_identity_key = 'win32:sid:' || windows_sid`
   - `platform = 'win32'`
   - `legacy_windows_sid = windows_sid`
   - `id`、版本和时间字段原样保留。
3. 校验复制行数与旧表一致，且 `local_identity_key` 无重复和空值。
4. 替换旧表并重建全部索引、外键和关系。
5. 执行 `PRAGMA foreign_key_check`；任何结果都会使迁移失败。

禁止通过应用启动代码逐行“补数据”；迁移必须可重复验证且失败时保持旧 schema。

### 3.3 兼容周期

- 迁移后的第一个版本读取和写入 `localIdentityKey`。
- `legacyWindowsSid` 只用于诊断和一个版本的 API 兼容，不参与资料查找。
- 下一次破坏性 schema 版本可删除旧 SID 字段，但必须先确认所有客户端已经改用 `identitySummary`。
- 不允许把 macOS UID 写入旧 `windows_sid` 字段伪装兼容。

## 4. 会话行为

启动时：

1. 读取 `LocalIdentityProvider`。
2. 按 `localIdentityKey` 查询资料。
3. 已存在时复用 `id`，仅在显示名变化时递增版本。
4. 不存在时创建新资料，默认时区仍为 `Asia/Shanghai`、工作日时长 8 小时。
5. 同一数据库发现多个本机资料时仍只绑定当前键，不合并数据。

会话公开字段见 [06-API 与前端行为](./06-api-contracts-and-frontend-behavior.md)。日志不得记录完整身份键。

## 5. 平台目录

### 5.1 macOS 原生默认值

| 用途        | 默认路径                                                     | 权限                 |
| ----------- | ------------------------------------------------------------ | -------------------- |
| 安装根      | `~/Library/Application Support/Auto Work`                    | `0700`               |
| 持久数据    | `~/Library/Application Support/Auto Work/data`               | `0700`               |
| 版本目录    | `~/Library/Application Support/Auto Work/releases/<version>` | `0755`，当前用户所有 |
| 日志        | `~/Library/Logs/Auto Work`                                   | `0700`               |
| 运行状态    | `~/Library/Application Support/Auto Work/run`                | `0700`               |
| 桥接目录    | `~/Library/Application Support/Auto Work/desktop-bridge`     | `0700`               |
| 默认仓库根  | `~/Projects`                                                 | 沿用现有权限         |
| LaunchAgent | `~/Library/LaunchAgents/com.autowork.local.plist`            | `0644`               |

`~` 只在安装脚本中使用当前用户 home 展开。应用配置保存并使用绝对路径，不在业务代码中自行展开波浪号。

### 5.2 Windows 与 Docker

- Windows 继续使用安装脚本配置的 `%LOCALAPPDATA%\AutoWork` 和明确仓库根。
- Docker 继续使用 `/app/data`、`/repositories` 和 `/app/desktop-bridge`。
- 源码开发仍允许相对路径，但统一以仓库根而非进程随机 cwd 解析。

## 6. 配置项

| 配置                                    | 默认/规则                                    | 优先级                         |
| --------------------------------------- | -------------------------------------------- | ------------------------------ |
| `AUTO_WORK_DEPLOYMENT_MODE`             | 正式安装显式写 `native`；Compose 写 `docker` | 环境变量最高                   |
| `AUTO_WORK_DATA_DIR`                    | macOS 安装脚本写绝对数据目录                 | 显式配置优先                   |
| `AUTO_WORK_REPOSITORY_ROOT`             | macOS 原生默认 `~/Projects` 的绝对展开值     | 显式配置优先                   |
| `AUTO_WORK_REPOSITORY_HOST_PATH`        | 仅 Docker 诊断展示                           | 只读事实                       |
| `AUTO_WORK_VAULT_BACKEND`               | macOS `auto` 解析为 `sealed`                 | 显式 `dpapi` 在非 Windows 拒绝 |
| `AUTO_WORK_VAULT_KEY_FILE`              | `<data>/vault-master.key`                    | 显式配置优先                   |
| `AUTO_WORK_DINGTALK_DESKTOP_BRIDGE_DIR` | `<data>/desktop-bridge`                      | Docker 和自定义目录可覆盖      |
| `AUTO_WORK_MACOS_BRIDGE_BUNDLE_ID`      | `com.autowork.desktopbridge`                 | 仅诊断/签名校验使用            |
| `AUTO_WORK_PLATFORM_OVERRIDE`           | 只允许测试环境                               | 生产环境出现即拒绝启动         |

平台默认值由纯函数根据 `platform`、`deploymentMode` 和 `homedir` 计算，必须覆盖 Windows/macOS/Linux 单元测试。

## 7. macOS sealed vault

### 7.1 首次创建

- 主密钥由密码学安全随机数生成。
- 数据目录先以 `0700` 创建，主密钥临时文件以 `0600` 创建并原子重命名。
- 若文件已存在，不得覆盖或静默重新生成。
- 文件所有者必须是当前 UID；组或其他用户存在写权限时启动失败。

### 7.2 备份与恢复

- 完整备份必须同时包含 SQLite、密文文件和 `vault-master.key`。
- 诊断包不得包含主密钥、密文或凭据引用。
- 恢复后先验证主密钥可读取一个专用测试记录，再允许集成进入 healthy。
- 丢失主密钥时不能尝试弱恢复；所有 `sealed:` 集成标记 invalid，并要求重新配置。

### 7.3 暂不使用 Keychain 的理由

现有 sealed vault 已具备认证加密、引用路由和 Docker 共用能力，引入 Keychain 会增加权限提示、签名绑定和迁移路径。首版先完成平台可用性和稳定桥接；未来可新增 `keychain:` 引用后端，而不改变数据库中集成的业务模型。

## 8. Windows 到 macOS 的数据迁移

### 8.1 可迁移内容

- SQLite 业务数据和审计历史。
- Excel/周报/季度导出、备份和诊断制品。
- 非秘密配置、字段映射和连接元数据。

### 8.2 不可直接迁移内容

`dpapi:` 引用只能由原 Windows 用户解密。macOS 不读取、不转换，也不要求用户复制明文文件。

迁移流程：

1. 在 Windows 上创建并验证完整备份。
2. 记录需要重新配置的集成类型和掩码，不导出秘密。
3. 停止 Windows 实例后复制数据与制品到 Mac 数据目录。
4. 首次启动执行 schema 和身份迁移；原 Windows 资料作为历史资料保留。
5. 当前 macOS UID 创建新的本机资料；由迁移向导显式选择接管原单用户业务资料，记录审计事件。
6. 所有 `dpapi:` 连接保持 invalid，用户逐项重新录入凭据，生成 `sealed:` 引用。
7. 验证 Git/Jira/GitLab/钉钉/AI 连接后再启用调度。

“资料接管”只允许数据库中恰有一个历史主资料且当前为单用户部署；存在多个候选时必须停止并人工选择，禁止按用户名猜测。

## 9. 回滚与失败处理

- schema 迁移前必须创建已验证备份。
- 迁移失败时旧版本继续使用原数据库，不能留下半迁移表。
- 迁移成功但新版本启动失败时，同 schema 可切回旧二进制；旧二进制不识别新 schema 时必须恢复备份。
- 身份读取失败不得创建新随机资料，避免业务数据看似丢失。
- sealed 主密钥权限异常时只阻断凭据能力；数据库和离线页面可进入 degraded 只读状态。
