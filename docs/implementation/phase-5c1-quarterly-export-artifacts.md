# 阶段五 C1：季度 Excel/Word 制品、作业生命周期与文件验收

## 1. 状态与边界

05C1 已完成基于确认快照的 Excel/Word 后台导出、文件存储、结构验收、失败/取消恢复、安全下载和人工视觉检查，状态为 `verified`。

本增量只读取确认时冻结的评审基本信息、成果、证据、指标模板、AI 建议、用户评分、确定性计算、正文和完整性事实，不回读活动成果或再次调用 AI。05C2 的完整季度绩效工作台尚未实现，因此总阶段 05C 仍未宣告完成；05D 的运维、诊断和发布门禁也不在本增量内。

## 2. 不可变输入与导出身份

确认时新增 `reviewSnapshotJson`，把名称、周期、时区和确认基线版本与原有五类快照一起冻结。升级迁移会根据季度聚合根的不可变周期字段和确认表的 `reviewVersion` 回填旧确认，避免已经确认的历史材料无法导出。

制品身份固定为：`reviewId + confirmation.snapshotHash + format + quarterly-export-v1`。同一身份处于 queued、running 或 succeeded 时只返回原制品；failed/cancelled 可以复用同一制品记录重排，新作业 ID、attemptCount 和 version 必须递增。成功制品禁止原地变化，源数据和后续确认也不会改写历史文件。

## 3. Excel 制品

Excel 使用应用正式依赖 ExcelJS 生成五个工作表：

1. `绩效自评`：周期、确认时间、快照、最终得分、五段正文、完整性与知悉项；
2. `指标评分`：指标定义、权重、明确标记的 AI 建议、用户评分/理由、逐项贡献公式、总分公式和公式版本；
3. `成果明细`：项目、成果五段结构、贡献边界、类型化业务日期和指标映射；
4. `证据索引`：证据类型、外部键、标题、时间、贡献角度、可用状态、可点击 URL 和内容哈希；
5. `数据说明`：确认/成果/评分快照哈希、模板与计算版本、完整性事实、AI 使用边界和不可变性声明。

用户分、权重和日期保持数值/日期类型。评分贡献与总分使用 Excel 公式并携带确认计算缓存结果；生成后重新加载工作簿，校验必需工作表、ZIP 魔数、类型化日期、公式存在性及确认总分对账。评分范围还保留 Excel 数据验证，AI 建议使用独立黄色底色，不能与用户分混淆。

## 4. Word 制品

Word 使用 `docx` 正式依赖，按 `standard_business_brief` 设计预设与 `editorial_cover` 页眉模式生成 Letter 纵向商务简报。文档包含封面与确认事实、总体概述、核心成果、指标评分表、成果与贡献边界、协作成长、问题改进、下周期计划、证据外链附录及生成说明。

正文只使用已确认 narrative 版本；表格采用固定页面可用宽度、重复表头、不可拆行和中文字体回退，页眉页脚包含材料标识与当前/总页码。生成后检查 DOCX ZIP、document/header/footer OOXML 部件、确认正文、快照哈希和全部外链关系。

## 5. 作业、文件与安全

`quarterly-review.export` 以并发 1、`safe_replay` 运行。制品状态只允许：

- queued → running → succeeded/failed/cancelled；
- failed/cancelled → queued，且尝试次数和作业身份递增；
- succeeded 终态不可变。

生成文件先写入同目录临时文件，再原子重命名到 `dataDir/quarterly-exports/<reviewId>/<artifactId>.<ext>`。崩溃或运行中取消遗留的同制品文件可在下一次安全重放中替换；成功文件不被覆盖。成功入账同时保存 SHA-256、字节数、MIME、结构 QA 和渲染事实。

下载前重新检查所有权、成功/QA 状态、受控根目录、文件存在性、字节数、SHA-256 和 ZIP 魔数；缺失或被篡改的文件直接拒绝。下载文件名同时提供安全 ASCII fallback 和 UTF-8 `filename*`，响应设置 `nosniff`。排队、重排、成功、失败和下载均有审计记录，审计不保存正文或文件内容。

## 6. API

| 端点                                                             | 行为                                       |
| ---------------------------------------------------------------- | ------------------------------------------ |
| `POST /api/v1/quarterly-reviews/:id/exports`                     | 为当前有效确认排队 xlsx/docx，支持安全重放 |
| `GET /api/v1/quarterly-reviews/:id/exports`                      | 列出最近 100 个导出制品及作业状态          |
| `GET /api/v1/quarterly-reviews/:id/exports/:artifactId`          | 读取制品、结构 QA 与渲染事实               |
| `GET /api/v1/quarterly-reviews/:id/exports/:artifactId/download` | 完整性复核后下载成功文件                   |

POST 必须提供格式有效的 `Idempotency-Key`；同一键与请求体可以重放首次 202 结果，同一键更换确认或格式会返回 409。取消继续复用通用作业取消端点；failed/cancelled 制品再次调用 POST 即可重排，不提供绕过确认快照的强制覆盖端点。

## 7. 验证证据

- 真实 SQLite 全迁移集成测试覆盖：排队安全重放、running 失败收尾与失败审计、同制品重排、冻结快照生成、Excel 公式/日期/超链接、queued 取消后重试、Word OOXML/外链、成功下载和篡改拒绝；
- Excel 用捆绑 artifact-tool 独立导入，五个工作表逐表渲染；公式扫描得到 J2 逐项贡献与 J3 总分公式，错误扫描为 0，确认总分为 4.5；
- Word 正式制品通过应用内 OOXML 检查；捆绑 `render_docx.py` 因当前 Windows 运行时没有 LibreOffice 未能完成转换，Microsoft Word 的 PDF 过滤器也在导出时挂起。随后直接在 Word 分页视图逐页检查最终 DOCX 的 3 页，封面、评分表、成果正文、证据外链、页眉页脚和附录均无截断、溢出或表格断裂；
- 本地 `auto-work.db` 已应用全部 25 个迁移；`PRAGMA integrity_check` 返回 `ok`，`PRAGMA foreign_key_check` 违规数为 0，`20260719070000_quarterly_export_lifecycle` 已完成且未回滚；
- Prisma schema validate、API 类型检查和 05C1 集成测试 4/4 通过；默认 `pnpm verify` 完整通过格式、全仓 lint、四包类型检查、contracts 2/2、domain 35/35、web 17/17、API 218/218，以及 Web/API 生产构建。

## 8. 后续增量

05C2 将把季度路由从占位页替换为完整工作台，贯通周期创建、来源收集、候选筛选、成果编辑、证据/指标映射、用户评分、AI 建议、自评版本、确认前置检查、知悉确认、导出作业轮询和文件下载。完成 05C2 后才把总阶段 05C 标记为 `verified`。
