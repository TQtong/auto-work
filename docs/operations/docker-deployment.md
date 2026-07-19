# Docker 部署与运维

## 1. 部署边界与组件

Docker 部署是 Auto Work 的推荐日常运行方式。一个 Compose 服务同时运行 Web、API、调度器和受限 Git
Worker；SQLite 仍保持单实例写入，不允许横向扩容多个副本。

```text
浏览器 127.0.0.1:<port>
          │
          ▼
Compose 回环端口发布 ──► Auto Work 容器（Web + API + 调度器）
                              │                 │
                              ▼                 ▼
                       auto-work-data       /repositories
                       命名持久卷            宿主机仓库挂载
```

容器内部必须监听 `0.0.0.0` 才能接受 Docker 端口转发，但 `compose.yaml` 固定把宿主机地址绑定为
`127.0.0.1`。不得把端口映射改成 `0.0.0.0:<port>:<port>`，也不得直接放到反向代理或公网。

## 2. 前置条件

- Windows/macOS：Docker Desktop，使用 Linux containers；
- Linux：Docker Engine 与 Docker Compose v2；
- 推荐至少 2 CPU、4 GiB 可用内存和 5 GiB 可用磁盘；
- 宿主机端口 3760（或所选 1024–65535 端口）未占用；
- Docker Desktop 已允许访问仓库所在驱动器/目录；
- 仓库挂载目录对容器 UID/GID 1000 具有业务所需的读写权限。

## 3. 首次部署

在项目根目录执行：

```powershell
Copy-Item .env.docker.example .env
notepad .env
docker compose config --quiet
docker compose up --detach --build --wait
docker compose ps
```

Linux 可将前两行换成：

```bash
cp .env.docker.example .env
${EDITOR:-vi} .env
```

Compose 首次启动会创建 `auto-work-data` 命名卷，入口脚本先执行 `prisma migrate deploy`，全部迁移成功后
才启动 API。`--wait` 只有在数据库、调度器和 Git Worker 就绪后才返回成功。浏览器访问：

```text
http://127.0.0.1:3760
```

### 3.1 配置项

| 变量                        | 默认值           | 说明                                                 |
| --------------------------- | ---------------- | ---------------------------------------------------- |
| `AUTO_WORK_PORT`            | `3760`           | 宿主机和容器共同使用的端口，范围 1024–65535          |
| `AUTO_WORK_REPOSITORY_PATH` | `./repositories` | 宿主机 Git 仓库根目录；Windows 推荐写成 `D:/company` |
| `AUTO_WORK_IMAGE_TAG`       | `local`          | 本地镜像标签                                         |
| `AUTO_WORK_LOG_LEVEL`       | `info`           | `trace/debug/info/warn/error/fatal`                  |

数据库路径、容器监听地址、Web 产物路径和密封保险箱后端由 Compose 固定为容器安全值，不建议在 `.env` 中覆盖。
如果修改端口，容器内外必须保持相同；当前严格 Host/Origin 校验不支持“宿主机 8080 转发容器 3760”。

## 4. 日常操作

```powershell
# 查看服务和健康状态
docker compose ps

# 跟踪最近 200 行日志
docker compose logs --follow --tail=200 auto-work

# 重启并等待重新健康；迁移会幂等复查
docker compose restart auto-work
docker compose up --detach --wait

# 停止并移除容器/网络，保留命名卷和全部业务数据
docker compose down

# 重新启动已有镜像
docker compose up --detach --wait
```

健康端点为 `GET /api/v1/health`。健康检查要求 HTTP 可用、数据库可读、实例租约已获取，而不是只判断端口开启。

## 5. 数据、备份与恢复

`auto-work-data` 卷包含以下不可分割的数据：

- `auto-work.db`、`auto-work.db-wal`、`auto-work.db-shm`；
- `backups`、`exports`、`diagnostics` 等业务制品；
- `vault/*.sealed` 凭据密文；
- `vault-master.key` 默认保险箱主密钥。

普通业务备份应优先使用应用运维页，它通过 SQLite `VACUUM INTO` 创建一致快照并执行 SHA-256、完整性、外键和
schema 校验。灾难恢复所需的完整卷备份必须在停止写入后同时保存数据库和主密钥：

```powershell
docker compose stop auto-work
$container = docker compose ps --all --quiet auto-work
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Path ".\backups\$stamp" | Out-Null
docker cp "${container}:/app/data/." ".\backups\$stamp"
docker compose start auto-work
docker compose up --detach --wait
```

恢复前先保留当前卷副本，再停止容器。数据库业务恢复应走应用内已验证备份和启动前恢复清单；整卷灾难恢复只用于
Docker 主机丢失等场景，必须恢复同一时点的完整 `data` 目录。禁止仅恢复数据库而遗失主密钥，否则已有集成凭据将永久
无法解密；也禁止只复制活动数据库而遗漏 WAL/SHM。

以下命令会删除整个持久卷，只有完成可恢复备份并得到数据所有者明确确认后才能执行：

```powershell
docker compose down --volumes
```

## 6. 凭据密钥与迁移

### 6.1 默认密钥

首次保存凭据时，容器会以独占创建方式生成 32 字节随机主密钥，Base64 编码后保存为
`/app/data/vault-master.key`，权限为 0600。每个凭据使用独立 12 字节 IV 和 AES-256-GCM 认证标签，并把引用 ID
绑定为附加认证数据；密文篡改、引用调包和错误密钥都会被拒绝。

默认密钥与密文位于同一卷，适合单机易部署场景，但 Docker daemon/卷管理员仍能读取它。高安全环境应把主密钥放在
Docker secret 或独立只读挂载中，并设置 `AUTO_WORK_VAULT_KEY_FILE` 指向该文件。密钥文件内容必须是恰好 32 字节
随机值的标准 Base64；不得使用口令、Git 中的文件或环境变量明文代替。

### 6.2 Windows DPAPI 数据迁入 Linux 容器

Windows 源码/发布包创建的引用前缀为 `dpapi:`，只能由原 Windows 用户解密；Linux 容器不能读取这些引用。迁移方式：

1. 在原 Windows 用户环境中记录需要重新配置的集成；
2. 备份数据库和原数据目录；
3. 启动 Docker 版后，在设置页撤销并重新输入每个集成凭据；
4. 确认新引用使用 `sealed:`，逐个执行连接测试；
5. 完成前不要删除原 Windows 数据目录。

代码支持按引用前缀读取 DPAPI 与 sealed 两种格式，但密码学边界决定了 Linux 无法代替原 Windows 用户解密 DPAPI。

## 7. 升级与回滚

升级前先在运维页生成并验证备份，再执行：

```powershell
git pull --ff-only
docker compose build --pull
docker compose up --detach --force-recreate --wait
docker compose logs --tail=100 auto-work
```

新容器会在启动前幂等应用尚未执行的迁移。构建或迁移失败时旧镜像不会被删除，但若 schema 已经前向变化，不能直接用
旧镜像连接新数据库。回滚规则与 Windows 发布包一致：同 schema 可切换旧镜像；不兼容 schema 必须恢复升级前已验证
备份。禁止修改已发布迁移或手工回退 SQLite 表。

## 8. 安全加固事实

默认 Compose 明确配置：

- `USER node`（UID/GID 1000），不以 root 运行应用；
- `read_only: true`，只有 `/app/data`、`/repositories` 和 tmpfs `/tmp` 可写；
- `cap_drop: [ALL]`；
- `no-new-privileges:true`；
- 固定 Dockerfile frontend、Node 22.14.0 基础镜像摘要和 pnpm 10.14.0；
- 停止宽限期 30 秒，tini 转发信号并回收子进程；
- 端口仅发布到 `127.0.0.1`。

仓库挂载是有意的业务写入面。应用仍会校验仓库位于配置根目录内，Git 命令禁用交互式凭据提示，并只允许设计中固定的
动作。不要把 Docker socket、宿主机根目录、用户主目录或额外敏感目录挂入容器。

## 9. 故障排查

### 容器 unhealthy

```powershell
docker compose ps
docker inspect (docker compose ps --quiet auto-work) --format '{{json .State.Health}}'
docker compose logs --tail=200 auto-work
```

优先检查迁移错误、数据卷权限、端口占用、数据库损坏和主密钥格式。入口迁移失败会让容器退出并按重启策略重试；修复
根因前不要删除卷。

### 仓库不可见或 Git 写入失败

- 检查 `.env` 中 `AUTO_WORK_REPOSITORY_PATH` 是否为宿主机绝对路径；
- Windows Docker Desktop 检查驱动器共享权限，并使用 `D:/company` 形式；
- Linux 检查目录对 UID/GID 1000 的权限；
- 不要通过给容器 root 权限来绕过宿主机目录权限。

### 端口占用

修改 `.env` 中 `AUTO_WORK_PORT` 后重新创建容器：

```powershell
docker compose down
docker compose up --detach --wait
```

### 主密钥丢失或错误

`VAULT_KEY_INVALID` 表示文件不是合法的 32 字节 Base64 密钥；`CREDENTIAL_DECRYPT_FAILED` 表示密文被篡改、密钥不匹配
或数据损坏。不要生成新密钥覆盖旧文件。恢复同一时点的主密钥备份；没有备份时只能逐个撤销并重新输入凭据。

## 10. 验收清单

每次目标主机首次部署或升级后至少确认：

1. `docker compose config --quiet` 通过；
2. 镜像构建成功且 `docker compose up --wait` 返回 0；
3. `docker compose ps` 为 `healthy`；
4. 浏览器首页和 `/api/v1/health` 可访问；
5. 日志显示迁移成功或 `No pending migrations to apply`；
6. 容器用户非 root、根文件系统只读、端口仅绑定 127.0.0.1；
7. 新增测试集成后数据目录不含凭据明文；
8. 重启容器后数据库记录、密钥、密文和仓库挂载仍可用；
9. 完成一次应用内备份、校验和恢复演练；
10. 企业 GitLab/Jira/钉钉/AI 仍需使用获批测试账号单独 UAT。
