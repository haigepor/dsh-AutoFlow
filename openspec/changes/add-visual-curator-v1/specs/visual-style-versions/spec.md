## ADDED Requirements

### Requirement: S1 Reference import and dimension intent

系统 SHALL 导入 JPEG、PNG 和静态 WebP，分别保存原文件、规范化图片及来源；每个样例 SHALL 关联正例/反例/待判断角色、参考维度和确认反馈。系统 SHALL 按配置限制文件、批量和解码规模，逐项报告成功与失败；重复字节复用 blob 但不合并不同风格的意图。

#### Scenario: S1a Import mixed reference intents
- **WHEN** 用户把一张图设为整体正例，把另一张图仅设为色彩正例
- **THEN** 系统保存两个明确的样例及确认来源，后者不产生构图、主体等未选维度的正标签

#### Scenario: S1b Reject invalid files without losing valid items
- **WHEN** 同批包含合法图片、超像素图片和动画文件
- **THEN** 合法项独立提交，其他项显示具体拒绝原因且不送视觉模型，批次不能显示全部成功

#### Scenario: S1c Reuse bytes across styles
- **WHEN** 同一文件再次导入另一个风格并被设为反例
- **THEN** 系统复用内容存储但保留独立样例和反馈，不改变原风格意图

### Requirement: S2 Evidence-backed editable rule drafts

系统 SHALL 将程序测量、模型估计和 unknown 分开；规则草稿 SHALL 保留支持图、反例、条件、例外、强度及 source/final 阶段，模型归纳只产生 suggested 规则。required 规则 SHALL 经人工确认且没有未解决冲突后才能形成可发布 candidate。

#### Scenario: S2a Observe ambiguity without inventing measurements
- **WHEN** 图片预览不足以确认主体细节，而模型估计主体占比
- **THEN** 系统保留未知和估计标记，不把估计写成精确测量或从标题补出主体事实

#### Scenario: S2b Resolve contradictory references
- **WHEN** 正例同时包含冷色与暖色，而模型提出“所有图片必须冷色”
- **THEN** 用户能看到反例关联并缩小条件、增加例外或撤销规则，未处理的 required 冲突阻止发布

### Requirement: S3 Immutable candidates and releases

系统 SHALL 在评估前保存不可变 StyleCandidate，在发布时固定规则、样例意图、审核器和匹配内容摘要的评估引用，并分配单风格递增 releaseNumber。已发布内容 SHALL 不可编辑；样例或审核器变化 SHALL 进入新 candidate/release。provisional 与 evaluated SHALL 不等同于未经声明的质量通过。

#### Scenario: S3a Publish a calibrated candidate
- **WHEN** 用户发布已确认且引用有效的 candidate
- **THEN** 系统提交一个可追溯 release，保留 candidate/recipe/样例摘要及评估状态，不自动改变 defaultReleaseId

#### Scenario: S3b Reject stale candidate evaluation
- **WHEN** 评估后草稿或审核器已变化，用户尝试用旧评估发布新内容
- **THEN** 系统拒绝不匹配摘要的发布，要求重建 candidate 并保留旧报告

#### Scenario: S3c Preserve old published evidence
- **WHEN** 用户修正样例或切换视觉模型
- **THEN** 已发布 release 和历史任务所读样例保持原快照，新内容只能进入新版本

### Requirement: S4 Independent usage revisions and explicit defaults

系统 SHALL 分开保存风格、不可变 UsageRevision 和任务题材。用途 SHALL 定义约分整数比例、相容的目标像素、成图安全区域和保护内容；默认版本选择 SHALL 是显式的、可回退操作。任务与 required 规则冲突 SHALL 在外部请求前拒绝，空默认不得退回草稿。

#### Scenario: S4a Reuse one style for two outputs
- **WHEN** 用户为同一 release 分别选择手机和桌面用途
- **THEN** 两个任务共用风格规则而固定各自用途，不把横图方向自动变成手机风格反例

#### Scenario: S4b Reject impossible task constraints
- **WHEN** 目标像素与比例不相容，或任务要求放宽该 release 的 required 条件
- **THEN** 系统在启动来源/模型请求前返回可纠正冲突，不静默修改规则或像素

#### Scenario: S4c Switch default without changing active work
- **WHEN** 用户从 release 2 回退默认到 release 1
- **THEN** 后续未显式选版本的任务解析为 release 1，已启动任务仍使用自己的固定 release

### Requirement: S5 Durable publication and revision conflicts

发布、默认切换和草稿修订 SHALL 校验 expectedRevision 并按同一 aggregate 串行提交。系统 SHALL 先持久化不可变依赖，最后提交单个 manifest；未被提交 manifest 引用的内容不得显示为已发布。operationId 重试 SHALL 幂等，不同请求摘要复用 operationId SHALL 拒绝。

#### Scenario: S5a Fail before publication commit
- **WHEN** 依赖已写入但 manifest 写入失败
- **THEN** 旧默认和已发布列表保持不变，操作报告 storage-commit-failed，恢复不能把孤立内容当作发布成功

#### Scenario: S5b Resolve concurrent edits
- **WHEN** 两个编辑请求携带相同 expectedRevision
- **THEN** 至多一个成功，另一个得到 revision-conflict 并保留用户草稿，不能后写覆盖前写

#### Scenario: S5c Retry publication safely
- **WHEN** 客户端未收到确认而以相同 operationId 和请求摘要重试
- **THEN** 系统返回原提交结果且只分配一次 releaseNumber；不同摘要的重试被拒绝

### Requirement: S6 Frozen execution review material

正式搜图和裁图 SHALL 只接受已发布 release，执行前固定 RunSpec 中的用途、规则、样例、recipe、来源配置及预算。每次辅助模型请求 SHALL 记录实际 ReviewBundle 和图片摘要；草稿和默认变更不得影响在途请求。

#### Scenario: S6a Edit references while a task runs
- **WHEN** 原图审核完成后用户修改样例或发布新版本，任务随后进入裁图
- **THEN** 裁图及成图复核继续采用原 release/recipe 和固定样例，不混用新标准

#### Scenario: S6b Refuse unreadable immutable evidence
- **WHEN** release 依赖的图片缺失、摘要改变，或调用者传入草稿作为正式搜索标准
- **THEN** 系统明确拒绝启动或继续相关步骤，不用最新样例、文字描述或另一图片替代
