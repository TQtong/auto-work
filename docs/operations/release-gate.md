# 发布门禁

## 1. 适用范围

本门禁用于 Auto Work 的 Windows 单用户本机发布。门禁通过只证明仓库内自动化检查和发布包完整；企业 GitLab、Jira、钉钉、机器人和 AI 的真实账号联调必须另附 UAT 记录，不能用 fixture 结果冒充。

## 2. 一键执行

在 Node.js 22.14、pnpm 10.14 和干净工作区中执行：

```powershell
pnpm install --frozen-lockfile
pnpm release:gate
```

`release:gate` 按顺序执行：

1. Prettier、ESLint、TypeScript、全部测试和生产构建；
2. Prisma schema 校验，在隔离临时数据库部署全部迁移并检查迁移状态；
3. Git 跟踪文件秘密扫描；
4. 生产依赖漏洞扫描，高危或严重漏洞使门禁失败；
5. 使用固定版本 cdxgen 生成 CycloneDX 1.6 SBOM，并再次解析 UTF-8 JSON、组件和依赖图；
6. 生成带版本、Git commit、schema、逐文件校验和的 ZIP 发布包。

门禁不会连接企业系统，也不会读取本机正式数据库。隔离数据库位于 `tmp/release-gate/database-<pid>`，结束后按精确目录删除。

## 3. 发布物

成功后 `dist/release` 包含：

- `auto-work-<version>.zip`：可交付发布包；
- `auto-work-<version>.zip.sha256`：ZIP 外部校验和；
- 展开目录中的 `release-manifest.json`、`SHA256SUMS` 和 `SBOM.cdx.json`；
- API/Web/共享包生产构建、Prisma 迁移、Windows 运维脚本和本运行手册。

交付前必须在独立目录重新计算 ZIP SHA-256，并展开后运行安装脚本的逐文件校验。任何不一致都应丢弃发布包，不能手工跳过。

## 4. CI

`.github/workflows/release-gate.yml` 在 Windows runner 上对 PR 执行同一门禁，并上传 14 天保留的候选发布物。四个第三方 action 均使用声明 `node24` 的稳定版本并锁定到 40 位 commit SHA，禁止浮动 tag；应用构建与测试仍由 setup-node 固定到 Node.js 22.14.0。CI 不是签名服务；当前版本提供哈希完整性，不提供 Authenticode 发布者身份保证。

最终维护基线 `f611b0908c42bd4cf096eb84171e2945f780ad7d` 的 run `29676804507` 已验证新 action 组合：完整发布门禁和 upload-artifact v7 均成功，check annotation 为 0。PR 事件中的 `${{ github.sha }}` 是 GitHub 生成的合并提交，因此制品名使用该合并 SHA；`release-manifest.json` 仍是候选包内容与源码提交绑定的权威事实。

## 5. 人工发布签字项

以下事项不适合由仓库脚本自动断言，发布负责人必须逐项记录：

- P0/P1 缺陷为零，未接受高风险安全项为零；
- 企业联调 UAT 使用获批的测试账号完成，外部写操作使用可丢弃范围；
- 真实 Excel 样表哈希未变化且导入回归通过；
- Excel/Word 结构、公式和视觉 QA 通过；
- 在候选包上完成一次安装、升级、同 schema 回滚和备份恢复演练；
- 已知限制已由使用者确认。

任一项缺证据时只能保留候选状态，不能把 Draft PR 或 CI 绿色状态描述为正式发布批准。
