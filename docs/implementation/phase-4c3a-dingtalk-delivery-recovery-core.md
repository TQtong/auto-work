# 阶段四 C3a：钉钉交付结果恢复与受控重试内核

## 1. 状态与边界

04C3a 完成正式日志 `unknown/needs_review` 的只读外部查询恢复、不可变恢复证据、人工裁决、新 attempt 受控重试和对应恢复工作台，状态为 `implemented`。本增量没有调用用户企业中的真实钉钉写接口，也不把 fixture 描述成企业联调成功。

机器人频控/静默窗口、Asia/Shanghai 提醒调度、休眠补偿、失败提醒和复制/导出降级仍属于 04C3b；这些完成前，04C3 与 `DNG-001/002/003` 不提升为整体 `verified`。

## 2. 官方查询契约

- 恢复查询固定使用 `POST https://oapi.dingtalk.com/topapi/report/list`，请求限定操作用户、模板名、创建时间窗口、游标和最大 20 条页大小。
- 查询契约依据阿里巴巴官方开发者文档中的 `dingtalk.oapi.report.list`：响应包含 `report_id`、`creator_id`、`template_name`、`create_time` 和 `contents`；当前钉钉 Workspace CLI 也把发件箱列表、详情查询和提交后反查作为独立能力。
- 参考：[官方日志列表 API](https://developer.alibaba.com/doc2/apiDetail.htm?apiId=37009)、[钉钉 Workspace CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)、[当前日志产品说明](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/skills/mono/references/products/report.md)。

## 3. 唯一匹配与零命中证明

- 查询只覆盖原 attempt 附近的窄时间窗口，并按官方游标最多读取 20 页；游标不前进或仍有更多页面时视为查询不完整，绝不据此宣布未创建。
- 使用确认时冻结的模板映射重新构造六字段，对 `key/sort/type/content` 逐项精确比较；该构造器与真实创建 handler 共用，避免恢复查询与提交字段漂移。
- 唯一精确命中才把 intent 恢复为 `succeeded` 并保存外部日志 ID；原 delivery attempt 继续保持 `unknown`，历史事实不被改写。
- 多个精确命中、分页不完整均进入 `needs_review/ambiguous`。
- 第一次零命中只记录 `not_found`。只有原尝试已跨过两分钟可见性宽限，并且相隔至少 30 秒的第二次完整查询仍为零命中，才形成 `absence_confirmed`，转换为明确失败并开放显式重试。

## 4. 人工裁决

- 只有 `unknown/needs_review` 可人工裁决；请求必须带当前 intent 乐观锁版本、至少五字原因和固定确认短语“我已在钉钉人工核对交付结果”。
- 裁决为已交付时必须填写外部日志 ID；裁决为未交付时禁止填写外部 ID/链接。
- 人工身份、时间、原因、结果和证据哈希写入 intent、不可变恢复检查和审计事件。原因正文不复制到审计摘要，只保存哈希。

## 5. 受控重试

- `unknown`、查询尚未完成、首次零命中或歧义状态禁止重放正式创建。
- 只有明确失败、连续查询确认不存在或用户明确确认不存在的 intent 才能创建新作业；每个作业仍设 `maxAttempts=1`，不会由 Job Runner 自动重试外部写入。
- 同一个 intent 最多三次显式 attempt；每次产生新 job ID、独立 attempt 号、原因哈希和审计事件。
- 重试前重新检查连接健康、当前凭证以及正式日志模板映射未变化/未过期。模板事实变化时要求重新确认周报，不沿用旧意图。
- 机器人明确失败可以只重试机器人通道，正式日志成功事实不会被重放或降级。

## 6. 持久化与隐私

- `delivery_intent` 增加恢复状态、最后查询时间、人工裁决人/时间/原因。
- 新增不可变 `delivery_recovery_check`，记录顺序、模式、结果、查询窗口、候选/精确命中数量、匹配外部 ID、证据哈希和非敏感摘要。
- 恢复记录不复制六字段正文、Access Token、App Secret、Webhook 或机器人 Secret；字段正文仍只存在于冻结周报版本。
- SQLite trigger 校验所有状态枚举、数量边界和恢复检查不可变性。

## 7. 自动化证据

本增量覆盖：

- 官方 `/topapi/report/list` 主机、路径、请求体、分页与响应 schema；
- 超时后六字段唯一命中恢复成功，且原 attempt 仍为 `unknown`；
- 第一次零命中不允许重试，跨可见性宽限的第二次零命中才允许；
- 明确允许后创建第二 attempt 并成功，不产生第三次外部调用；
- 多精确命中转 `needs_review`，再由带固定确认短语和外部 ID 的人工裁决恢复；
- 原有双通道幂等、附件/模板门禁、部分交付和重复点击测试继续通过。

## 8. 恢复工作台与浏览器验收

- 页面按 intent 当前状态生成动作矩阵：`unknown/needs_review` 只显示只读查询和人工裁决，绝不显示重试；明确失败且未达到三次 attempt 上限时才显示受控重试。
- 查询弹窗明确展示窄时间窗口、冻结六字段精确匹配和首次零命中不开放重试；人工裁决弹窗按“已找到/确认未创建”切换外部 ID 门禁，并要求固定强确认短语；重试弹窗展示通道、次数、恢复事实和修正原因。
- 交付行可展开查看最后核对、人工裁决、每次不可变检查的模式/候选数/精确命中数和可复制证据哈希。
- 使用全新隔离 SQLite 数据库和生产构建，在 1280×900 视口完成浏览器验收：未知正式日志没有重试入口，机器人明确失败有受控重试入口，三个弹窗均可打开并安全取消；页面无横向溢出，控制台无 warning/error。验收没有点击任何外部写确认按钮。

## 9. 后续 04C3b

下一增量实现机器人通知类型与去重、429/5xx Retry-After 策略、Asia/Shanghai 提醒调度与休眠补偿，以及清楚标记“未正式提交”的六字段复制/附件导出降级。
