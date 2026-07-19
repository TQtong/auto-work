# Auto Work

Auto Work 是按照仓库内详细设计实现的 Windows 单用户本机研发工作台。它统一管理本地 Git
仓库、GitLab/Jira 元数据、Excel 任务证据、六字段周报、钉钉交付与季度绩效材料。

## 安全边界

- 默认仅监听 `127.0.0.1:3760`，不提供远程或多用户访问。
- Git 写操作只能经固定动作模型完成，先预检、再批准、执行前复核。
- Jira 与 GitLab 首版只读；AI 无工具调用权限，也不能读取源码、diff 或附件。
- 凭证只进入 Windows 用户范围保险箱，SQLite 仅保存引用与掩码。
- 正式周报提交、机器人通知和绩效导出均独立幂等并可审计。

## 本地开发

```powershell
Copy-Item .env.example .env
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

首次部署或升级已有环境时使用幂等迁移命令：

```powershell
pnpm db:deploy
pnpm db:status
pnpm build
pnpm --filter @auto-work/api start
```

相对数据路径始终以仓库根目录为基准。首次迁移会自动创建数据目录和 SQLite 文件；运行数据、备份、导出、诊断包与秘密均被排除在 Git 之外。

提交前执行完整质量门禁：

```powershell
pnpm verify
```

完整范围、业务规则和验收标准见 [详细设计文档](./docs/detailed-design/README.md)。
实现进度、测试证据和未关闭项见 [实现追踪](./docs/implementation/README.md)。
