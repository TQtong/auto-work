# 阶段六：Docker 完整部署

## 范围与状态

状态：`verified`。

本增量把生产运行方式从每次源码启动扩展为可重复的 Docker Compose 部署，并保持原有业务、安全、凭据、备份与迁移能力，
不是仅能展示页面的精简镜像。

## 实现

- 多阶段 Dockerfile：冻结安装、Linux Prisma Client、按依赖顺序干净构建、仅生产依赖运行时；
- Compose：回环端口发布、命名数据卷、宿主机仓库挂载、健康检查、自动重启与 30 秒停止宽限；
- 入口：每次启动先执行 27 个幂等迁移，失败时拒绝启动；
- 安全：非 root、只读根文件系统、tmpfs、移除 capabilities、`no-new-privileges`、固定基础镜像摘要；
- 凭据：新增 AES-256-GCM 密封文件保险箱、并发安全主密钥创建、认证密文和引用前缀路由；
- 兼容：Windows 默认仍用 DPAPI；备份目标路径改为平台原生分隔符；
- 构建：修复 `dist` 缺失而增量缓存存在时的工作区错误判定，基础包强制项目构建；
- 运维：README 和 Docker 安装、升级、备份、恢复、密钥、排障文档。
- 仓库：新增扫描目录状态 API 与配置弹窗，展示宿主机/容器路径、访问性、候选数、重建步骤和完整扫描报告；
- 目录选择：Windows 本机部署使用固定 PowerShell/WinForms 文件夹窗口并回填经验证的绝对路径；Docker 使用浏览器目录
  选择器，绝对路径不可见时明确要求人工复制，不猜测路径；
- Git：执行文件按 Windows/Linux 自动选择，对 Docker bind mount 仅注入当前仓库精确 `safe.directory`；
- 发现：身份登记与完整 `git status` 解耦，避免大仓库超时后已入库却在报告中被误写为跳过。

## 自动化证据

- `pnpm --filter @auto-work/api typecheck`；
- `pnpm --filter @auto-work/api lint`；
- 新增 AppConfig、密封保险箱、篡改、错误密钥、并发首启和路由测试，共 12 项定向断言通过；
- `docker compose config --quiet`；
- Docker Linux 引擎上从无镜像缓存完成多阶段构建；
- 新卷首启成功应用 27 个 Prisma 迁移；
- 重启日志显示 `No pending migrations to apply`；
- 健康检查达到 `ready/healthy`，首页返回生产 HTML；
- `docker inspect` 验证用户 `node`、只读根文件系统、`CapDrop=[ALL]`、`no-new-privileges`；
- 真实 HTTP/CSRF 创建测试集成，卷内生成 32 字节主密钥的 Base64 文件与 sealed 密文，全文扫描无测试 token 明文；
- 容器重启后 SQLite、主密钥、密文和集成记录仍在原命名卷。
- Windows Docker Desktop 真实挂载 `D:/company`，诊断得到 14 个一级目录和 14 个 Git 候选；
- HTTP/CSRF 真实发现 14 个仓库耗时 3.78 秒，结果登记 14、警告 0，列表名称与宿主机目录集合一致；
- 浏览器实测配置弹窗、14 行列表和扫描路径状态，无页面横向溢出；Linux Docker CI 增加真实临时 Git 仓库发现。

## 边界

- Docker 仍是单用户本机部署，不支持远程、多副本或反向代理；
- Windows DPAPI 凭据无法在 Linux 容器中解密，必须在 Docker 版重新配置；
- 企业系统真实账号联调不由本地容器 smoke test 替代；
- 完整卷备份必须包含 `vault-master.key`，密钥丢失不可恢复已有密文。
