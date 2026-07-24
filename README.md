# Auto Work

Auto Work 是面向单用户的本地研发工作台，统一管理 Git 仓库、GitLab/Jira 元数据、Excel
任务证据、六字段周报、钉钉交付和季度绩效材料。项目现在推荐使用 Docker Compose 部署：镜像内同时包含
Web 与 API，启动时自动部署数据库迁移，浏览器直接访问，不需要每次执行源码开发命令。

## Docker 一键部署（推荐）

前置条件：Docker Desktop 或 Docker Engine 已启动，并支持 Docker Compose v2。

```powershell
Copy-Item .env.docker.example .env
# 按实际情况编辑 .env 中的 AUTO_WORK_REPOSITORY_PATH
docker compose up --detach --build --wait
```

启动成功后访问 <http://127.0.0.1:3760>。查看状态和日志：

```powershell
docker compose ps
docker compose logs --follow --tail=200 auto-work
```

进入“项目与仓库”后，页面会直接显示宿主机仓库路径、容器内路径、可访问状态、一级目录数和 Git
候选数。“配置并扫描”会给出可复制的环境变量及容器重建命令；配置正确时再启动后台扫描，并展示登记数量和逐项警告。
路径输入框右侧提供“选择目录”：Windows 本机进程可直接打开系统文件夹窗口并回填绝对路径；Docker 模式由浏览器打开目录
选择器，若浏览器按安全策略隐藏绝对路径，会显示已选目录名并要求从资源管理器地址栏复制完整路径，不会猜测磁盘位置。
Docker 的宿主机 bind mount 必须在容器启动前确定，因此修改路径后必须重新创建容器，不能只在网页中保存一个无效路径。

默认部署具备以下完整运行能力：

- 启动前自动、幂等执行全部 Prisma 迁移，迁移失败则拒绝启动；
- Web 静态站点与 API 由同一容器提供，并带数据库/调度器就绪健康检查；
- SQLite、备份、导出、诊断包、凭据密文和保险箱主密钥持久化到 `auto-work-data` 卷；
- 宿主机仓库根目录挂载到容器 `/repositories`，Git 读写仍受应用固定动作和批准流程限制；
- Windows 与 Linux 容器自动选择 `git.exe`/`git`，并只对当前已校验仓库声明精确 `safe.directory`；
- 容器以非 root 用户运行，根文件系统只读，移除全部 Linux capabilities；
- 容器内部监听 `0.0.0.0`，但 Compose 只把端口发布到宿主机 `127.0.0.1`，不开放局域网访问；
- Linux/Docker 使用 AES-256-GCM 认证加密凭据，Windows 源码运行继续默认使用当前用户 DPAPI。

### 无接口权限提交钉钉正式日志

如果公司普通员工无法申请任何钉钉应用或日志权限，可使用“钉钉桌面正式日志”连接。它复用当前 Windows 用户已经登录的钉钉客户端，校验公司、模板、六字段和接收群后提交，不需要 AppKey、CorpID、UserID、Secret 或 Token。

Docker 部署需要同时在宿主机登录会话中运行本地桌面桥接。推荐一次性安装当前用户的登录任务（不需要钉钉或公司管理员权限）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Install-DingTalkDesktopBridgeTask.ps1 `
  -BridgeRoot .\data\desktop-bridge
```

安装后会立即启动，并在当前 Windows 用户每次登录时自动运行。临时手动运行仍可使用 `Start-DingTalkDesktopBridge.ps1`。

完整配置、失败恢复、安全边界和真实提交 UAT 见[钉钉桌面正式日志](./docs/operations/dingtalk-desktop-automation.md)。

完整的安装、配置、升级、备份、恢复、密钥托管、Windows DPAPI 迁移和故障处理见
[Docker 部署与运维](./docs/operations/docker-deployment.md)。停止容器不会删除数据：

```powershell
docker compose down
```

`docker compose down --volumes` 会永久删除数据库、备份和凭据主密钥，不能作为普通停止命令使用。

## 安全边界

- 产品仍是单用户本机工作台，不支持公网、局域网、多用户或反向代理部署；
- Git 写操作只能通过固定动作模型完成，先预检、再批准、执行前复核；
- Jira 与 GitLab 首版只读；Jira 连接后自动全量拉取个人任务，每天 06:00 增量更新，并在任务页提供一个手动刷新按钮；Web 端不提供字段映射或 Jira 写操作；
- AI 按任务日期和状态变化生成周报、绩效草稿；AI 无工具调用权限，也不能读取源码、diff 或附件；
- SQLite 只保存凭据引用和掩码，秘密仅以 DPAPI 或 AES-256-GCM 密文落盘；
- 正式周报提交、机器人通知和绩效导出均独立幂等并可审计。

## Windows 源码开发

Docker 是日常部署入口；只有开发和调试时才需要以下命令：

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm dev
```

生产式源码启动和 Windows 发布包安装仍受支持，详见
[Windows 安装、升级与回滚](./docs/operations/installation-upgrade-rollback.md)。提交前执行完整质量门禁：

```powershell
pnpm verify
```

业务范围和验收标准见[详细设计](./docs/detailed-design/README.md)，逐阶段实现和验证证据见
[实现追踪](./docs/implementation/README.md)。
