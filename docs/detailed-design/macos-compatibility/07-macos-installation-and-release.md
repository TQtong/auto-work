# 07 macOS 安装、升级与发布

## 1. 交付目标

macOS 原生版本采用与 Windows 相同的“版本目录 + 持久数据 + current 指针”模型，通过用户级脚本和 LaunchAgent 管理。首版不提供 App Store、自动更新服务或 root 安装器。

正式支持：

- macOS 13.0 及以上；
- Intel `x86_64` 和 Apple Silicon `arm64`；
- Node.js `>=22.14.0 <23`；
- pnpm `10.14.0`；
- Git CLI；
- Safari 或 Chrome。

## 2. 发布包结构

```text
auto-work-<version>/
  apps/
  packages/
  scripts/
    macos/
      common.sh
      install.sh
      upgrade.sh
      rollback.sh
      start.sh
      stop.sh
      install-desktop-bridge.sh
    windows/
  native/
    macos/
      Auto Work Desktop Bridge.app/
  docs/
  package.json
  pnpm-lock.yaml
  release-manifest.json
  SBOM.cdx.json
  SHA256SUMS
```

包使用 `.tar.gz` 和对应 `.sha256` 发布，避免 ZIP 丢失 Unix 可执行位。正式包中的桥接 `.app` 必须已经签名、公证并 stapled。

## 3. 用户目录布局

```text
~/Library/Application Support/Auto Work/
  data/
  releases/<version>/
  current -> releases/<version>
  run/
  desktop-bridge/
~/Library/Logs/Auto Work/
~/Library/LaunchAgents/com.autowork.local.plist
~/Applications/Auto Work Desktop Bridge.app
```

- 安装根、data、run 和 bridge 目录权限 `0700`。
- 发布代码目录当前用户可读，不允许组或其他用户写入。
- `current` 是指向已校验版本目录的符号链接，替换时使用临时链接和原子 rename。
- 桥接应用安装到 `~/Applications`，保持稳定路径和签名身份。

## 4. 脚本职责

### 4.1 `common.sh`

- 验证当前系统为 Darwin、版本不低于 13、UID 不为 0。
- 解析并校验安装根，禁止 `/`、home 根或未展开变量作为破坏性目标。
- 检查 Node、pnpm、Git 和固定系统工具。
- 校验发布包 `SHA256SUMS`、release manifest 和 schema 版本。
- 提供版本目录、环境文件、LaunchAgent、健康检查和安全备份公共函数。
- 所有 shell 脚本启用 `set -euo pipefail`，变量始终引用，不使用 `eval`。

### 4.2 `install.sh`

输入：发布包根、可选安装根、仓库根、端口和 `--no-start`。

步骤：

1. 运行平台和依赖检查。
2. 拒绝已有 current 安装，提示改用 upgrade。
3. 验证所有校验和、manifest 和桥接签名。
4. 创建受保护目录并复制 release。
5. 写入不含秘密的 `.env`，部署模式固定为 `native`。
6. 执行 `pnpm install --prod --frozen-lockfile`、Prisma generate/deploy/status。
7. 安装桥接应用和两个用户级 LaunchAgent。
8. 原子创建 current 指针。
9. 启动并等待 `/api/v1/health` ready。

任一步失败都清理未激活的版本目录；不得删除已存在 data。

### 4.3 `start.sh` / `stop.sh`

- `start.sh` 使用 `launchctl bootstrap gui/<uid>` 和 `kickstart` 启动 API。
- LaunchAgent 工作目录固定为 current release，stdout/stderr 写入用户日志目录。
- 启动脚本验证 current 目标、入口文件、端口和 health。
- `stop.sh` 使用 `launchctl bootout`，只停止匹配 label 的当前用户任务。
- 不使用宽泛 `pkill node`，不按端口强杀未知进程。

桥接 LaunchAgent独立管理；停止 API 不强制退出钉钉或删除桥接权限。

### 4.4 `upgrade.sh`

1. 验证新发布包。
2. 通过当前实例创建并验证一致性备份。
3. 安装新版本到未激活目录。
4. 安装生产依赖并执行离线校验。
5. 停止旧 API，执行数据库迁移。
6. 原子切换 current 和 LaunchAgent ProgramArguments。
7. 启动新版本并等待健康检查。
8. 失败时按 schema 兼容规则切回旧版本；必要时恢复升级前备份。

桥接升级先验证新签名与 Bundle ID相同，再替换应用。若需要新增系统权限，升级说明必须明确，且桌面提交保持 disabled 直到用户授权。

### 4.5 `rollback.sh`

- 同 schema：停止当前版本、切换 current、重新加载 LaunchAgent、健康检查。
- 不兼容 schema：要求指定已验证的升级前备份，执行启动前恢复，再切换版本。
- 回滚前再次生成紧急备份；失败时保留当前数据库和所有日志供人工恢复。
- 不自动降级桥接到不同协议；API manifest 必须声明兼容的桥接协议范围。

## 5. 环境文件

macOS 安装生成：

```dotenv
NODE_ENV=production
AUTO_WORK_HOST=127.0.0.1
AUTO_WORK_PORT=3760
AUTO_WORK_DEPLOYMENT_MODE=native
AUTO_WORK_DATA_DIR=/Users/<user>/Library/Application Support/Auto Work/data
AUTO_WORK_DATABASE_URL=file:/Users/<user>/Library/Application Support/Auto Work/data/auto-work.db
AUTO_WORK_REPOSITORY_ROOT=/Users/<user>/Projects
AUTO_WORK_VAULT_BACKEND=sealed
AUTO_WORK_VAULT_KEY_FILE=/Users/<user>/Library/Application Support/Auto Work/data/vault-master.key
AUTO_WORK_DINGTALK_DESKTOP_BRIDGE_DIR=/Users/<user>/Library/Application Support/Auto Work/desktop-bridge
AUTO_WORK_LOG_LEVEL=info
```

安装器必须正确引用含空格路径。环境文件权限 `0600`；即使当前不含秘密，也不扩大读取范围。

## 6. LaunchAgent 设计

### 6.1 API Agent

- Label：`com.autowork.local`
- `RunAtLoad=true`
- `KeepAlive` 只对非零退出采用受限重启，不形成快速崩溃循环。
- ProgramArguments 为固定 Node 路径、API 入口和配置加载方式。
- `ProcessType=Background`。
- 不设置监听到 `0.0.0.0` 的覆盖变量。

### 6.2 Bridge Agent

- Label：`com.autowork.desktopbridge`
- 仅在 GUI 用户域启动。
- ProgramArguments 指向稳定 `.app` 内 helper。
- 桥接连续崩溃时由 launchd 限流，平台能力显示 offline。
- 不以 root 或系统域启动，否则隐私权限和桌面会话均不正确。

## 7. Universal 桥接构建

构建流程：

1. 使用同一源码分别构建 `arm64-apple-macos13` 和 `x86_64-apple-macos13`。
2. 使用 `lipo` 合并并验证两种架构。
3. 生成固定 Info.plist、Bundle ID、版本和所需隐私用途说明。
4. 对嵌套 helper 和 `.app` 从内到外签名。
5. 使用 `codesign --verify --strict --deep` 和 `spctl` 验证。
6. 提交 Apple 公证，成功后 staple。
7. 将签名 Team ID、bundle version、二进制哈希和架构写入 release manifest。

临时/ad-hoc 签名只允许开发和 CI 非发布测试。缺少正式签名或公证时不得产出“正式 macOS 发布包”。

## 8. Release manifest 扩展

```json
{
  "runtime": {
    "os": ["Windows 10/11 x64", "macOS >=13 arm64/x86_64", "Docker Linux containers"],
    "node": ">=22.14.0 <23",
    "binding": "host loopback only"
  },
  "macos": {
    "minimumVersion": "13.0",
    "architectures": ["arm64", "x86_64"],
    "bridgeBundleId": "com.autowork.desktopbridge",
    "bridgeProtocol": { "minimum": 2, "maximum": 2 },
    "signed": true,
    "notarized": true,
    "requiredPermissions": ["accessibility", "screenRecording", "automation"]
  }
}
```

## 9. macOS Docker Desktop

`.env` 示例：

```dotenv
AUTO_WORK_REPOSITORY_PATH=/Users/alice/Projects
AUTO_WORK_DINGTALK_DESKTOP_BRIDGE_HOST_PATH=/Users/alice/Library/Application Support/Auto Work/desktop-bridge
AUTO_WORK_PORT=3760
```

- Docker Desktop 必须被授予仓库和桥接目录文件共享权限。
- Compose 内部路径继续为 `/repositories` 和 `/app/desktop-bridge`。
- 原生 Finder 选择器不可用于改变已运行容器的 bind mount。
- 桥接运行在 macOS 宿主 GUI 会话，不打包进 Linux 镜像。

## 10. 升级和回滚验收

- 全新安装、重复安装拒绝、正常启动和登录启动。
- 端口冲突、Node/pnpm/Git 缺失、发布包哈希错误。
- 数据目录和仓库路径包含空格与中文。
- 同 schema 升级和回滚。
- 不兼容 schema 升级、失败恢复和备份回滚。
- 桥接签名不匹配、未公证、协议不兼容。
- 休眠/唤醒后 API、调度租约和桥接心跳恢复。
- 卸载仅移除应用和 LaunchAgent；持久数据默认保留并明确提示位置。
