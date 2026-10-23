## ADDED Requirements

### Requirement: F1 Authenticated feedback and model suggestions

人工反馈 SHALL 包含 data-model 定义的 subject、context、kind/value、scope、实际查看版本及 Host 派生的 actor。Agent/模型 SHALL 只创建有原作者标记的 Suggestion，不能通过客户端自报字段、工具调用或批处理结果冒充人工确认。导入正反样例确认 SHALL 使用同一反馈来源。

#### Scenario: F1a Confirm the image actually viewed
- **WHEN** 用户对某个预览或裁后版本明确点击确认
- **THEN** 保存的反馈绑定该 imageVersionId、版本/用途/任务上下文和真实人类操作，不扩大为未查看原图的质感确认

#### Scenario: F1b Refuse forged human authorship
- **WHEN** Agent 提交建议并在输入中声称 actor 是 human
- **THEN** 系统拒绝非法字段或将其保持为 Agent 建议，不能产生人工标签、确认规则或变更发布版本

### Requirement: F2 Scoped multidimensional feedback

反馈 SHALL 区分风格、维度、题材相关性、用途、偏好比较、裁剪、事实纠正及规则建议。默认 task-only；纳入风格下一版 SHALL 经用户明确选择 style-candidate，且仍需校验用途和新草稿适用性。未知、本次不需要和题材不符 SHALL 不转换为风格负例。

#### Scenario: F2a Decline a good image for this task
- **WHEN** 雪山任务返回符合风格的森林图，用户选择题材不符或本次不需要
- **THEN** 任务排除该图但风格正反样例不改变，分类训练导出不将它标为审美拒绝

#### Scenario: F2b Accept color but reject composition
- **WHEN** 用户确认某图色彩符合、构图过密并选择纳入风格
- **THEN** 系统保留相反的两个维度标签及明确作用范围，不能合并为整图全部通过或全部拒绝

#### Scenario: F2c Keep a correction local until its scope is confirmed
- **WHEN** 用户仅说“这张太暗”或选择 task-only
- **THEN** 系统保存该图判断，规则扩大为“所有图片更明亮”只能成为待确认建议

### Requirement: F3 Append-only revisions with one effective head

改判 SHALL 创建新反馈并以 supersedesFeedbackId 指向同一 subject/context/kind/维度的当前有效头，不覆盖历史。提交 SHALL 校验 expectedHead/revision，重复 operationId 幂等；导出和草稿读取只采用已提交有效头，历史快照保留原引用。

#### Scenario: F3a Correct an earlier verdict
- **WHEN** 用户把之前拒绝改为接受
- **THEN** 新记录成为当前头，旧记录仍可追溯，后续筛选采用新头而已生成快照保持不变

#### Scenario: F3b Reject a stale or cross-context revision
- **WHEN** 两个改判并发，或 supersedes 指向另一裁图/用途的反馈
- **THEN** 至多一个同头修订成功，跨上下文替代被拒绝，不产生两个同时有效的标签

#### Scenario: F3c Recover after a partial feedback write
- **WHEN** 新反馈已保存而线程头提交失败
- **THEN** 新反馈不成为有效标签，旧头保持可读，相同 operationId 恢复只完成或返回一次结果

### Requirement: F4 Explicit comparison and crop supervision

偏好比较 SHALL 固定两边的图片版本、相同风格/用途及比较题材，支持 left/right/tie/neither/unknown。裁剪拖动、浏览、下载、沉默及普通批量接受 SHALL 不自动成为人工理想裁剪或逐图风格标签；只有明确确认并允许纳入样例的结果具有相应监督资格。

#### Scenario: F4a Record an undecided comparison
- **WHEN** 用户对同一比较任务选择平局、均不合适或无法判断
- **THEN** 系统准确保存该选择，不强制生成 A 胜 B 的偏好训练行

#### Scenario: F4b Abandon a manual crop
- **WHEN** 用户拖动裁剪框后关闭窗口或取消
- **THEN** 系统不生成 confirmed 理想区域，导出不能纳入该未完成调整

#### Scenario: F4c Confirm a selected crop for learning
- **WHEN** 用户确认合法成图并明确选择可纳入裁剪样例
- **THEN** 记录父图、实际区域、成图、风格/用途及人工确认，geometry 失败仍不能成为自动合格结果

### Requirement: F5 Review queues and controlled standard updates

系统 SHALL 提供 unknown、规则冲突、新类型和普通结果抽检的复核队列，显示模型判断、证据及反馈差异。反馈 SHALL 只影响下一草稿的候选内容；发布前人工确认、摘要匹配评估及默认切换规则持续适用。

#### Scenario: F5a Propose a rule from repeated mistakes
- **WHEN** 多张图获得相同构图纠正
- **THEN** 系统可提出带反馈引用的规则建议并展示受影响样例，未确认和发布前不改变现有 release 或默认任务结果

#### Scenario: F5b Audit confident automated decisions
- **WHEN** 当前没有低置信或冲突项且配置了普通结果抽检
- **THEN** 队列仍包含配置选出的通过/拒绝项，不能只复核模型主动报告的问题
