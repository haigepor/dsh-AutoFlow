## ADDED Requirements

### Requirement: E1 Family-based learning development and holdout splits

数据划分 SHALL 使用已确认 family，原图、派生裁剪、同源重复及确认连拍不得跨 learning/development/holdout；每次修改生成不可变 SplitManifest。holdout SHALL 不进入规则归纳、ReviewBundle、训练导出或阈值调整；近似分组未确认时不得声明独立评估。

#### Scenario: E1a Keep derivatives together
- **WHEN** 同一原图及两个裁剪被请求划入不同集合
- **THEN** 系统拒绝该划分并列出同 family 冲突，不生成可声明独立性的 manifest

#### Scenario: E1b Keep holdout out of learning
- **WHEN** 当前风格草稿归纳规则、选择参考图或导出训练行
- **THEN** 系统排除 holdout 资产/反馈，即使它们也存在于样例库

#### Scenario: E1c Reclassify a revealed test set
- **WHEN** 用户查看 holdout 错误后选择据此修改规则
- **THEN** 记录揭示和用途变化，将该组移入新 development/regression manifest，后续独立结论需要新 holdout

### Requirement: E2 Candidate comparison and honest quality reports

评估 SHALL 支持已发布 release 与不可变 candidate，在相同数据、用途、预算和计分方法下对比，并保存输入摘要和每项原始记录。指标 SHALL 展示分母、样本数、unknown/技术失败、风格接受/误收/漏选、裁图破坏/接受及调用/耗时；无分母显示 unavailable。evaluated SHALL 不能被解释为自动达到业务质量目标。

#### Scenario: E2a Evaluate before publishing
- **WHEN** 用户比较默认 release 和待发布 candidate
- **THEN** 系统无需提前发布 candidate 即可生成报告，发布时只接受匹配 candidate 摘要的报告

#### Scenario: E2b Report missing labels and execution failures
- **WHEN** 一组没有人工标签，另一组有模型调用失败
- **THEN** 无标签指标为 unavailable，失败进入全批完成统计而不伪装为审美负例，不生成虚假 100% 接受率

#### Scenario: E2c Keep an underperforming version optional
- **WHEN** candidate 某指标改善而裁图破坏率恶化
- **THEN** 报告显示两项及分母和变化，系统不自动替换默认，用户可保留旧 release

### Requirement: E3 Effective human labels and immutable export snapshots

导出 SHALL 固定 release/usage、SplitManifest、请求时有效反馈头、图片摘要及格式版本，只采用范围适用的人工确认；Agent 建议、unknown、本次不需要、题材不符及未确认裁剪不得自动变成风格/理想裁剪训练标签。相同 operationId 的请求 SHALL 幂等，后续反馈修订不得改写已生成文件。

#### Scenario: E3a Export a corrected label
- **WHEN** 用户将拒绝改为接受后创建新的分类导出
- **THEN** 新导出引用当前有效头，旧导出仍引用原头；历史反馈和旧 checksum 不变

#### Scenario: E3b Exclude unsupported supervision
- **WHEN** 选择范围包含 Agent 建议、task-only 不需要、unknown 和关闭前未确认的裁框
- **THEN** 它们不进入对应风格/裁剪训练行，导出说明排除数量与原因

#### Scenario: E3c Isolate training and evaluation exports
- **WHEN** 用户导出 training 类型数据
- **THEN** 只包含 learning family，development/holdout 只能经明确独立导出类型取得且保留 split 标识

### Requirement: E4 Versioned formats and controlled image bytes

第一版 SHALL 生成 data-model 定义的风格包、classification/preference/crop JSONL 和 Skill Markdown，带 manifest、字段/格式版本、family/split、来源反馈与 checksum。默认导出资产引用；附带图片字节 SHALL 同时要求用户显式选择、资产授权为 bytes-allowed 及资源可读取，不从搜索可见推断授权。系统 SHALL 不声称导出已经训练模型或直接兼容未验证框架。

#### Scenario: E4a Download a reference-only style pack
- **WHEN** 用户保持默认图片选项导出风格
- **THEN** 产物包含规则、版本和资源清单，不夹带未选择的原图字节或凭据

#### Scenario: E4b Refuse unauthorized or corrupt bytes
- **WHEN** 用户选择附图但某资产仅允许引用、缺失或摘要不符
- **THEN** 带图导出在提交前明确失败并列出安全原因，不静默生成缺图完整包；用户可另建 references-only 导出

#### Scenario: E4c Preserve comparison semantics
- **WHEN** 导出平局、均不合适或合格裁图比较记录
- **THEN** 按格式保留其准确值和比较上下文，不强制改成胜负或整图风格标签

### Requirement: E5 Skill output does not activate global instructions

生成 Skill SHALL 是固定风格快照的可读流程文档，含 release、规则、参考资源访问、工具调用流程及 unknown/失败处理。导出 SHALL 只产生可预览下载的产物，不修改 Home AGENTS/Skills、当前 Session 上下文或插件开关；生成文字不得宣称包含图片权重或已学会全部视觉偏好。

#### Scenario: E5a Review the generated guide
- **WHEN** 用户预览或下载 Skill Markdown
- **THEN** 文档指向明确 release/资源和操作要求，Home 指令目录及现有会话均不发生启用副作用

#### Scenario: E5b Use a pack without available references
- **WHEN** Skill 引用资源在目标环境不可用
- **THEN** 文档和运行步骤要求获取授权资源或报告缺失，不指导 Agent 用文字想象图片并宣称已完成视觉校验
