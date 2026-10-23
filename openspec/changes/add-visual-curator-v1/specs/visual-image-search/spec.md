## ADDED Requirements

### Requirement: Q1 Bounded configured source and real pagination

第一版 SHALL 提供一个通过部署配置声明的 HTTP JSON 来源，支持受限 GET/POST 请求字段、JSON Pointer 响应映射和凭据引用，不执行任意表达式。搜索 SHALL 区分规划和实际调用；首屏不带 cursor，后续只使用相同查询上下文成功返回的 cursor。不合法响应及空/重复 cursor SHALL 停止该查询并记录协议错误，不无限循环或伪造新游标。

#### Scenario: Q1a Fetch first and next pages
- **WHEN** 用户发起合法查询并取得 continuation cursor
- **THEN** 首屏没有占位游标，下一页沿同一 query/language/filter 和真实 cursor 请求，页面与后续状态持久提交

#### Scenario: Q1b Reject an invalid source response
- **WHEN** items 映射缺失、稳定 ID 缺失，或下一页返回重复 cursor
- **THEN** 该查询以 source-protocol-error 停止，保留已保存候选，不能重复请求相同页面充当新结果

#### Scenario: Q1c Refuse unconfigured or executable mappings
- **WHEN** endpoint/字段映射缺失，或输入包含 JavaScript 表达式和任意 URL
- **THEN** 操作在外部 I/O 前拒绝并给出配置指引，模型和任务不能自行补成其他来源

### Requirement: Q2 Explicit fixed search specification

搜索 SHALL 在启动前解析已发布风格、UsageRevision、任务题材、来源和预算，并保存 QueryPlan 与 RunSpec。初版 SHALL 只在实际召回的候选中筛选，不声称进行了未配置的向量/全图库检索；默认版本改变不影响在途任务。

#### Scenario: Q2a Search without vector infrastructure
- **WHEN** 用户选择已发布风格和关键词来源且没有 Embedding 服务
- **THEN** 系统完成关键词规划、真实召回与视觉审核，并说明结果来自该来源已返回的候选

#### Scenario: Q2b Resolve style before remote calls
- **WHEN** defaultReleaseId 为空、版本归属错误或用途与 required 规则冲突
- **THEN** 系统不启动远程调用，要求显式修正版本/条件，不退回草稿或放宽要求

### Requirement: Q3 Unique assets and verified deliverable resolution

候选 SHALL 先按来源身份与精确摘要去重；近似内容只作为提示，未经确认不得误合并。预览、原图和最终版本 SHALL 分别保存，缺少可取得或足够像素的素材不得计为满足输出要求的结果。阶段计数 SHALL 按 data-model 的唯一对象定义。

#### Scenario: Q3a Encounter the same image on several pages
- **WHEN** 不同查询/页面返回相同来源 ID 或相同字节
- **THEN** 结果不重复计数和审核，来源出现记录保留，targetCount 只由 distinct 合格成图增加

#### Scenario: Q3b Receive only a small preview
- **WHEN** 预览可用而原图不可访问，且预览达不到目标输出像素
- **THEN** 允许浏览或记录意图，最终结果标记素材不足并继续预算内补图，不能把插值放大当作原图质量通过

### Requirement: Q4 Pixel-grounded staged visual assessment

审核 SHALL 使用固定 ReviewBundle 和实际图片，逐条返回 satisfied/violated/unknown/not-applicable、依据及估计来源。source required 失败可拒绝；仅 final 构图不符且可能裁剪改善 SHALL 保留为 crop-candidate。标题、说明和模型自报 confidence SHALL 不替代像素证据及 required 检查。

#### Scenario: Q4a Preserve an editable composition
- **WHEN** 横图题材和固有风格合格，但当前主体位置或留白不适合竖屏
- **THEN** 系统进入裁剪可行性评估而不因方向直接作风格拒绝

#### Scenario: Q4b Refuse caption-only acceptance
- **WHEN** 标题符合主题但图片中无法确认目标主体
- **THEN** 结果为依据画面的拒绝或 needs-review，不能只凭标题和高 confidence 标为通过

#### Scenario: Q4c Distinguish vision execution failure
- **WHEN** 视觉请求超时或返回不合法 JSON/字段
- **THEN** 保存技术失败和可重试信息，没有伪造的 reject 审美 verdict

### Requirement: Q5 Qualified final selection and stable ranking

最终结果 SHALL 先满足程序检查及所有适用 required 项，阻塞 unknown 进入 needs-review，再按固定 recipe 的偏好量表/权重排序并用稳定 ID 破同分。需裁剪任务 SHALL 以实际裁后图的审核作为最终依据，不得用原图通过覆盖裁后失败。

#### Scenario: Q5a Avoid averaging away a required failure
- **WHEN** 一张图色彩偏好分高但违反必要主体要求
- **THEN** 它不进入自动合格结果，其他分项不能抵消该失败

#### Scenario: Q5b Preserve deterministic selection from saved assessments
- **WHEN** 对同一组已保存审核记录重新投影结果，且偏好分相同
- **THEN** 排名使用既定稳定排序，不重新调用模型，也不因列表刷新改变同分顺序

#### Scenario: Q5c Refuse a visually damaged crop
- **WHEN** 原图通过而所有裁后版本的 final required 项失败
- **THEN** 该图片不满足本次用途目标数量，保留原图通过记录并继续补图

### Requirement: Q6 Budgets and explicit incomplete results

搜索 SHALL 在 targetCount、页量、候选量、视觉/下载预算和截止时间内工作，所有尝试含重试占用预算。完成 SHALL 返回 target-met、source-exhausted、budget-exhausted 或 partial-failure 及实际合格数量；来源全失败返回 failed。部分查询失败导致不足 SHALL 不能冒充正常来源耗尽；系统 SHALL 不通过重复、未知或降低标准凑够数量。

#### Scenario: Q6a Finish with fewer qualified images
- **WHEN** 目标为 10 张，预算用尽时只有 6 张最终合格
- **THEN** 保存并返回 6 张、budget-exhausted 和完整计数，原规则和阈值不变

#### Scenario: Q6b Bound concurrent reservations
- **WHEN** 多个 worker 同时准备发起最后一次允许的视觉请求
- **THEN** 原子配额预留只允许剩余额度内的请求启动，重试也不能越过硬限制

#### Scenario: Q6c Report partial query failure honestly
- **WHEN** 某查询失败、其他查询已结束，目标不足而预算尚未用尽
- **THEN** 系统保留已合格结果并返回 partial-failure 与查询错误，不报告 source-exhausted 或丢弃已有成果

### Requirement: Q7 Honest source recovery

恢复 SHALL 使用已提交页面、合法 cursor、已保存素材和预算账本；来源支持时按稳定 ID 刷新短期媒体定位，签名地址不得持久化。定位不可刷新或 continuation 失效 SHALL 明确报告，不能把未读取项当风格拒绝或静默从首屏重搜。

#### Scenario: Q7a Resume a committed page
- **WHEN** 保存了页面候选与下一 cursor 后 Host 重启
- **THEN** 恢复不重复已提交审核，继续合法下一步骤，runId/RunSpec 不变而 attemptId 更新

#### Scenario: Q7b Handle expired source state
- **WHEN** 尚未下载的媒体地址无法刷新，或来源拒绝保存的 cursor
- **THEN** 系统分别保留 media-unavailable 或 source-continuation-invalid 原因，用户显式新建搜索才能重搜，不能显示原任务无缝继续
