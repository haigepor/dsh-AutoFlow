## ADDED Requirements

### Requirement: C1 Explicit coordinate system and output geometry

裁剪 SHALL 绑定具体规范化 ImageVersion、源方向映射、已发布 release 和 UsageRevision。模型区域 SHALL 使用 data-model 定义的归一化坐标，经确定性算法转换为有效整数 p:q 窗口；Host SHALL 保存原请求与实际区域，拒绝越界、非有限数、负面积和不相容用途，且第一版不得上采样、拉伸或扩图。

#### Scenario: C1a Crop an orientation-normalized source
- **WHEN** 原文件带旋转方向，预览和模型使用已定向图片
- **THEN** 实际裁剪使用同一 ImageVersion 的宽高和坐标，保存源映射且输出比例/像素精确满足用途

#### Scenario: C1b Reject invalid model geometry
- **WHEN** 模型返回 NaN、负宽度、超出图片的区域或不能容纳目标像素的窗口
- **THEN** 该候选得到具体几何失败，不静默夹取、放大或另切一块宣称成功

#### Scenario: C1c Record ratio adjustment before review
- **WHEN** 合法建议区域需要缩成精确整数比例
- **THEN** 系统记录 requestedRect 与 effectivePixelRect，视觉复核查看按实际区域生成的成图，不能继续使用调整前的判断

### Requirement: C2 Feasibility and protected content

系统 SHALL 在批量生成前判断目标比例/像素与必要主体、背景关系及安全区是否可同时满足。可行、不可能和未知 SHALL 分别记录；无法可靠判断 SHALL 进入 needs-review，不能仅凭模型坐标可解析就断言主体已保留。

#### Scenario: C2a Preserve a landscape through a valid portrait crop
- **WHEN** 原图有足够像素且一块 9:16 区域可保留必要主体与空间关系
- **THEN** 系统允许生成候选，不因原图为横幅拒绝

#### Scenario: C2b Decline an impossible two-subject crop
- **WHEN** 3840×2160 原图的两个必要主体无法同时进入最大 1215×2160 的 9:16 区域
- **THEN** 系统报告不可合理裁剪并保留原因，搜索可继续补图，不改为拉伸、扩图或删除某个必要主体

#### Scenario: C2c Keep uncertain content for review
- **WHEN** 预览不足以确认裁剪是否截断重要肢体或必要背景
- **THEN** 系统获取可判断像素或标为 needs-review，不将 unknown 算成通过

### Requirement: C3 Actual-image review with fixed style

系统 SHALL 在配置数量/调用预算内生成不同构图候选，分别保存真实派生文件，先做程序几何检查，再用原 release/recipe 的 final 规则检查实际成图。原图、候选、成图判断 SHALL 分开；required 失败和阻塞 unknown 不进入自动合格，候选排序只在通过必要条件后使用偏好分。

#### Scenario: C3a Select a better actual composition
- **WHEN** 居中裁剪过密而另一合法候选保留空间感及用途安全区
- **THEN** 两个成图分别审核，并按固定标准选择后一合格版本，显示真实区域及判断

#### Scenario: C3b Reject all damaged derivatives
- **WHEN** 原图审核通过，但有限候选都破坏主体或 final required 构图
- **THEN** 保留原图通过和每个成图拒绝记录，返回不可裁剪/需人工，不把原图结果复制为成图通过

#### Scenario: C3c Bound repeated proposal attempts
- **WHEN** 模型持续建议相同、无效或不合格区域
- **THEN** 系统按区域去重并在候选数/尝试/总预算上限结束，不能无限要求模型重试

### Requirement: C4 Human edits and qualified selections

人工调整 SHALL 先形成未确认预览，显式完成后保存新派生版本并运行几何及成图检查；保存与纳入训练样例 SHALL 是可区分的确认。用户可保留带视觉警告的合法版本，系统 SHALL 明确区分 human-selected 与 auto-qualified，不允许几何非法结果交付。

#### Scenario: C4a Confirm a manual crop
- **WHEN** 用户在目标比例内调整区域并确认完成
- **THEN** 系统保存新实际区域、派生图及复核结果，用户明确纳入学习后才形成裁剪监督

#### Scenario: C4b Preserve a warning without hiding it
- **WHEN** 合法人工成图违反风格 final 规则，而用户明确保留
- **THEN** 该图标记人工选择和具体警告，不能计入自动合格数量或静默生成风格正例

#### Scenario: C4c Cancel an edit
- **WHEN** 用户拖动后取消或关闭预览
- **THEN** 已确认裁图不被覆盖，不产生新的 confirmed 反馈或理想区域

### Requirement: C5 Immutable derivative lineage and cancellation

每个派生版本 SHALL 保存父图、源摘要、requested/effective 区域、输出处理参数、处理器版本及审核引用。原图 SHALL 不覆盖；文件和引用校验完成前不得交付。取消 SHALL 遵守 runtime 的准入/排空语义，不发布未提交文件。

#### Scenario: C5a Reconstruct a selected result
- **WHEN** 用户重新打开某次已提交裁图
- **THEN** 系统展示对应父图、实际区域、成图摘要和审核，文件缺失/摘要不同明确失败，不用新生成文件冒充旧结果

#### Scenario: C5b Cancel during image generation
- **WHEN** 临时文件已生成但取消先于派生引用提交
- **THEN** 临时文件不能经预览/导出读取，原图和已提交候选保留，取消确认后无新增成功结果
