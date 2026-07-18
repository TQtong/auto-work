# Windows 安装、升级与回滚

## 1. 前置条件

- Windows 10/11 x64；
- Node.js `>=22.14.0 <23`；
- pnpm 10.14.0；
- 当前 Windows 用户对安装目录、数据目录和仓库根目录有权限；
- 默认端口 3760 未被占用；
- 发布 ZIP 的 SHA-256 与同行 `.zip.sha256` 一致。

脚本默认安装到 `%LOCALAPPDATA%\AutoWork`，数据固定保存在安装根目录的 `data`，应用版本位于 `releases\<version>`。版本切换只原子更新 `current.version`，不会覆盖旧版本目录或业务数据。

## 2. 首次安装

先展开 ZIP，再在展开后的 `auto-work-<version>` 目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Install-AutoWork.ps1 `
  -PackageRoot $PWD `
  -RepositoryRoot D:\company
```

安装脚本会依次：

1. 拒绝磁盘根目录和已有安装；
2. 校验 `SHA256SUMS` 中每一个文件；
3. 复制到全新版本目录，不覆盖同名目录；
4. 写入仅本机使用的 `.env`；
5. 冻结安装生产依赖、生成 Prisma Client；
6. 幂等部署全部迁移并检查状态；
7. 迁移全部成功后才更新当前版本指针并启动；
8. 等待 `/api/v1/health` 通过后报告地址。

需要人工启动时传 `-NoStart`，之后执行：

```powershell
& "$env:LOCALAPPDATA\AutoWork\releases\<version>\scripts\windows\Start-AutoWork.ps1"
```

## 3. 升级

升级前必须保持当前应用可访问，因为脚本通过受 CSRF 保护的本机 API 创建 SQLite `VACUUM INTO` 一致性备份，并继续执行 SHA-256、`quick_check`、`foreign_key_check` 和 schema 校验。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Upgrade-AutoWork.ps1 `
  -PackageRoot D:\packages\auto-work-0.2.0
```

升级流程：

1. 校验新包全部文件；
2. 创建并验证升级前备份；
3. 停止当前 PID 记录对应的进程；
4. 复制新版本到全新目录；
5. 冻结安装生产依赖、生成 Client；
6. 在共享数据目录幂等部署迁移并检查状态；
7. 记录 `upgrade-history\<version>.json` 和备份哈希；
8. 迁移成功后才切换 `current.version` 并启动新版本。

任何步骤失败时不得删除旧版本和升级前备份。迁移失败后脚本不会猜测数据库是否仍兼容，也不会自动启动旧程序；按运行手册检查迁移和备份后处理。

## 4. 同 schema 应用回滚

当当前版本和目标版本的 `schemaChecksum` 相同时，可只切换应用：

```powershell
& "$env:LOCALAPPDATA\AutoWork\releases\<current>\scripts\windows\Rollback-AutoWork.ps1" `
  -TargetVersion 0.1.0
```

脚本停止当前进程、保留双向 `previous.version`、原子切换版本并重新健康检查。不会修改数据库。

## 5. 不兼容 schema 回滚

不兼容 schema 禁止直接启动旧二进制。必须使用升级历史中记录的升级前备份：

```powershell
$install = Join-Path $env:LOCALAPPDATA 'AutoWork'
& "$install\releases\<current>\scripts\windows\Rollback-AutoWork.ps1" `
  -TargetVersion 0.1.0 `
  -BackupFile "$install\data\backups\auto-work-....db" `
  -ExpectedSha256 '<升级历史中的64位哈希>' `
  -BackupSchemaChecksum '<目标版本schemaChecksum>' `
  -Confirmation '恢复备份并回滚 0.1.0'
```

脚本只接受 `data\backups` 内的文件，重算哈希并比对目标 schema，随后写入启动前恢复清单。目标版本启动时在 Prisma 建立连接前复制并复核备份，原子移动当前数据库为 `pre-restore-emergency-*`，清除精确的旧 WAL/SHM，再切换恢复库。恢复失败时当前数据库保持或回到原位。

该流程会把数据库恢复到升级前时刻，升级后的本地变更不会保留。执行前必须得到数据所有者确认。

## 6. 文件与日志

- 当前版本：`%LOCALAPPDATA%\AutoWork\current.version`；
- 上一版本：`previous.version`；
- 业务数据：`data\auto-work.db`；
- 一致性备份：`data\backups`；
- 升级记录：`upgrade-history`；
- PID：`run\auto-work.pid.json`；
- 标准输出/错误：`logs\app.stdout.log`、`logs\app.stderr.log`。

禁止用资源管理器覆盖活动数据库、删除 `data`、复制单独的 WAL/SHM，或在未校验 schema 时手工修改版本指针。
