# 阶段一：基础与安全内核实现与验证

## 1. 交付范围

本增量实现可复用的完整基础设施，不以假数据冒充后续业务功能：

- pnpm monorepo、共享 TypeScript/ESLint/Prettier 配置、契约包和领域包。
- NestJS + Fastify 本机服务、React + Ant Design SPA 壳、统一错误信封和请求关联 ID。
- SQLite/Prisma 全量领域 schema、初始迁移、WAL/外键/busy timeout/quick check。
- Windows 当前用户会话、SID 绑定、Host/Origin/CSRF 防护、安全响应头。
- Windows 用户范围 DPAPI 保险箱；数据库只保存随机引用、提供者和掩码。
- 个人资料、身份别名、乐观版本、配置写审计。
- 持久化作业、实例租约、作业租约、心跳、进度、取消、去重、重试和启动恢复。
- 集成生命周期：新增、掩码显示、测试作业、禁用、撤销；替换凭证必须先通过新凭证探测。
- 在线一致备份、SHA-256、隔离 quick check、每日调度、健康和运维页面。
- 总览、设置与集成、作业/审计/备份页面；后续领域入口明确展示依赖阶段，不伪造业务完成。

## 2. 安全不变量

1. 服务默认只绑定 `127.0.0.1:3760`，Host 不在白名单时在到达控制器前返回 403。
2. 写请求同时要求同源 Origin、HttpOnly 会话 Cookie 和基于会话秘密计算的 CSRF HMAC。
3. 凭证明文只通过请求内存和 PowerShell 标准输入进入 DPAPI，不写命令行、数据库和日志。
4. 替换凭证采用“写入新引用 → 新凭证能力探测 → 原子切换 → 删除旧引用”；探测失败删除新引用并保留旧凭证。
5. 外部写作业在结果未知时进入人工核对语义，启动恢复不会盲目重放。
6. 所有 ID 使用 UUIDv7；并发写使用版本或唯一幂等键约束，不依赖页面防重。
7. SQLite URL 统一转换为仓库根目录下的绝对路径，CLI 与运行时不会连接到两个同名数据库。

## 3. 需求追踪

| 需求 | 当前状态 | 实现证据 | 验收证据/剩余项 |
| --- | --- | --- | --- |
| SYS-001 | verified | `main.ts` 固定 loopback；`LocalSecurityService` 校验 Host/Origin | 自动化 Host/Origin/CSRF 测试；实际 HTTP 伪造 Host 返回 403 |
| SYS-002 | implemented | 初始迁移、WAL、在线备份、哈希与隔离 quick check | 全新目录迁移与备份文件 quick check 已通过；发布阶段补充正式恢复演练报告 |
| SYS-003 | implemented | 持久化队列、租约、心跳、恢复策略、每日备份调度 | 真实备份作业已完成；后续 Jira/Git/提醒处理器加入各自故障恢复矩阵 |
| SYS-004 | implemented | Windows SID 资料、别名、验证/启用字段、乐观版本 | 页面与 API 已验证；阶段三补多作者、重名和 Jira 身份 fixture 后升级为 verified |
| SEC-001 | implemented | DPAPI 保险箱、随机引用、掩码、秘密字段不回显 | 代码扫描和运行时路径已检查；发布门禁补数据库/日志/诊断包自动秘密扫描 |
| SEC-002 | implemented | 新增、测试、掩码、禁用、撤销与先测后换状态机 | 生命周期 UI 已验；具体提供者探针在对应适配器增量逐个验收 |
| SEC-003 | implemented | 资料、别名、集成和备份等写操作审计；审计查询页 | 阶段二至五写动作必须逐项加入审计抽样矩阵后升级为 verified |

## 4. 可复现验证

```powershell
# 全新目录首次部署；命令会自动创建目录和数据库文件
$env:AUTO_WORK_DATA_DIR='data/cli-fresh'
Remove-Item Env:AUTO_WORK_DATABASE_URL -ErrorAction SilentlyContinue
pnpm db:validate
pnpm db:deploy
pnpm db:status

# 静态质量、类型、自动化测试与生产构建
pnpm verify
```

人工运行验证覆盖：

- `/api/health` 数据库 quick check 为 `ok`；会话、资料、作业和备份 API 返回统一信封。
- 实际执行 `backup.create`，作业进度达到 100%，备份记录包含 SHA-256 且隔离校验通过。
- `/`、`/settings` 和 `/operations` 生产 SPA 深链均返回 200。
- 总览、个人资料、集成配置弹窗、作业列表在 1280×720 下可用，无水平溢出、无浏览器错误或警告。
- 伪造 Host 请求在安全钩子处返回 403。

## 5. 尚未关闭的全局工作

此增量仅关闭基础设施工作包。GitLab/Jira/钉钉/AI 的真实能力探测、受限 Git Worker、Excel、周报、正式提交、绩效导出、完整秘密扫描、故障注入、安装升级回滚和 UAT 会在后续独立提交中实现和验证；当前 UI 对这些能力只展示真实依赖状态。
