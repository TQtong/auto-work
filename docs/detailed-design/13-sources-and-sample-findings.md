# 13 外部依据与样表核验

## 1. 资料使用原则

本文件区分三种可信度：

- **需求已确认**：来自根目录 `design.md`，代表用户给定的业务环境与决策。
- **本机样本已核验**：对指定 Excel 进行只读解析，代表该文件事实，不代表所有未来文件。
- **平台一般能力**：来自官方公开文档，仍需在公司自建实例/组织权限中实测，不能直接视为已开通。

查阅日期均为 2026-07-17。

## 2. 需求基线

- 根目录 `design.md`，标题“多项目研发、周报与绩效管理系统设计方案 v1.2”。
- 已确认环境：`D:\company`、14 仓库、自建 GitLab/Jira、钉钉周报模板、本机 Windows Web、外部 AI、写操作人工确认、AI 不改源码。
- 本详细设计不修改该文件，只在独立目录展开。

## 3. Excel 样表核验

文件：`C:\Users\WIN11\Downloads\P_Manager_20260129_HQ_【gis功能】.xlsx`，只读检查，未改写。

### 3.1 工作表和范围

| 工作表 | 实际范围 | 列数 | 数据特点 |
|---|---:|---:|---|
| 后端开发jira | A1:H11 | 8 | 父/子任务、经办人、日期、工时；H 无标题 |
| 前端开发jira | A1:H15 | 8 | 多个未排期/空工时任务；H 无标题 |
| 系统测试jira | A1:G5 | 7 | 目前只有父任务容器 |

### 3.2 已确认公式

- 后端 H2:H11 为 `G/8`。
- 后端 F4:F11 多数为 `WORKDAY(E, CEILING(G/8,1)-1)`。
- 前端 H3:H15 为 `G/8`。
- 空 G 配合 H 公式时，读取的计算/缓存表现可能为 0；因此 0 不能覆盖“原始工时为空”的语义。

### 3.3 已确认数据形态

- 后端存在父任务 A/B 为空并继承上一有效父任务的行。
- 前端存在子任务/经办人有值而日期、工时为空的行。
- 日期有 Excel 数字序列、日期/公式缓存结果混合。
- 系统测试 sheet 没有 H 列，不能把 H 作为全工作簿必需列。
- 样表含具体姓名，仅可作为待匹配值，不能写死为当前用户。

### 3.4 对设计的直接影响

1. 导入器必须同时读取单元格原始类型、公式和缓存值。
2. 父继承以 sheet 为边界；父容器不直接成为个人周报项。
3. 空工时、明确 0、公式派生人日是三种语义。
4. 现有子任务行没有独立 issue key，不能只按父 issue key 去重所有子任务。
5. WORKDAY 结果按原文件读取；没有企业节假日配置时不重算覆盖。

## 4. GitLab 官方资料

### 4.1 REST 与分页

- [GitLab REST API](https://docs.gitlab.com/api/rest/)：REST 根路径、项目 path URL 编码、offset/keyset 分页、`Link` 和 `X-*` 分页头。
- [Projects API](https://docs.gitlab.com/api/projects/)：项目资源和 path/ID 使用。
- [Branches API](https://docs.gitlab.com/api/branches/)：仓库分支读取。
- [Commits API](https://docs.gitlab.com/api/commits/)：Commit 列表和查询。
- [Merge requests API](https://docs.gitlab.com/api/merge_requests/)：MR 列表/状态。
- [Pipelines API](https://docs.gitlab.com/api/pipelines/)：项目 Pipeline、筛选和分页。
- [Releases API](https://docs.gitlab.com/api/releases/) 与 [Tags API](https://docs.gitlab.com/api/tags/)：季度发布证据候选。

设计结论：跟随服务端分页链接/头，不假设总数一定存在；公司自建版本可能缺少新字段，连接测试保存能力矩阵。

## 5. Jira 官方资料

- [Jira Data Center REST API introduction](https://developer.atlassian.com/server/jira/platform/rest/v10000/intro)：Data Center REST、认证选项和分页语义。
- [Jira Data Center search API](https://developer.atlassian.com/server/jira/platform/rest/v10000/api-group-search/)：`GET/POST /api/2/search`、JQL、fields、startAt/maxResults。
- [Personal access token](https://developer.atlassian.com/server/jira/platform/personal-access-token/)：PAT 作为外部集成认证方式。
- [About Jira Server REST APIs](https://developer.atlassian.com/server/jira/platform/about-the-jira-server-rest-apis/)：资源、expand 和分页注意事项。

设计结论：实际返回页长和 total 可能变化/缺失，字段和认证取决于公司版本；使用字段发现和版本化映射，不复制 Jira Cloud v3 假设到 Data Center `/rest/api/2`。

## 6. 钉钉官方资料

- [钉钉开放平台能力中心](https://open.dingtalk.com/)：公开列出钉钉日志能力（获取模板、读取/写日志）和机器人能力，但具体接入形态与企业权限需进一步确认。
- [自定义机器人创建与接入](https://open.dingtalk.com/document/dingstart/custom-bot-creation-and-installation)：自定义机器人、Webhook 和安全设置入口（原需求链接可能重定向到此页面）。

设计结论：正式日志和 Custom Webhook 是两条不同通道；公司组织中的日志 API/MCP 权限、模板字段、接收范围、查询和幂等能力必须 Phase 0 实测。无法实测时只交付“未提交”的复制/导出降级，不采用网页登录自动化。

## 7. 未核实、不得直接实现为常量的事项

- GitLab/Jira 精确版本与每页上限。
- GitLab PAT/Jira PAT 的公司实际 scope 和过期策略。
- Jira 计划开始、Sprint、父任务、工时的 field ID。
- Jira 状态中文名称全集及统一映射。
- 钉钉日志的具体 endpoint、应用授权、模板字段 ID、字符/附件限制。
- Custom Webhook 频控、消息长度和公司群安全策略。
- 工作日历和法定调休数据源。
- 季度指标、权重、总分公式、取整与文件模板。
- 外部 AI 的批准供应商、区域、留存和数据处理条款。

这些事项必须通过配置、能力探测或版本化模板解决，不允许散落在代码常量中。

