## Context

现有模型画像导出包含 5 个校验文件，RunEngine 已提供持久任务、检查点、幂等启动和所有者检查。导出工作流只在最终保存 files/resources 计数；弹窗用局部 exportRun 标识任务，关闭受 launching 限制，工作区没有专门的数据集入口。用户提供的真实包已核验为 10 张引用、68 条模型观察、7/14 条启用规则和 5 个分组，其中 3 组含启用规则。

## Goals / Non-Goals

**Goals:** 真实进度；关闭和重开保持同一任务；复用图库任务卡片；按素材集分页列表；查看冻结快照；授权下载与可见失败；深浅主题及窄屏可用。

**Non-Goals:** 修改格式 2 文件内容、训练模型、安装导出 SKILL、增加图片导出权限、迁移旧监督数据、合并其他插件或重新分析参考图。

## Decisions

### Progress remains owned by the existing export run

使用既有 checkpoint JSON 保存经过验证的导出阶段与计数，沿用 RunEngine 的状态、Jobs 和恢复机制。阶段为核验引用、整理样本、封装文件、保存；未知总量或请求确认阶段呈现不确定进度。阶段变化与完成计数提交检查点，频繁更新按现有进程进度频率合并。相比 Client 定时推算，这能在关闭、刷新和恢复后重建实际状态，不改变已有导出字节。

### Lists project task and artifact identities together

增加当前所有者、素材集范围内的轻量分页读取，合并导出 run 与 profileExport，提供稳定条目身份、runId/exportId、styleId、画像 ID/版本、创建时间、模型、数量、大小、状态和进度。完成结果保留原授权下载路径。详情从不可变导出文件投影，规则、分组与样本保持来源；文件预览受既有 maxExportPreviewChars 限制。相较在 Client 拼接当前画像，这能正确查看历史版本并避免跨素材集和 Session 泄漏。

### The workbench owns submission and background observation

工作台 store 持有 operationId、启动请求、runId、轻量列表与详情。弹窗只观察状态，启动请求不能因弹窗关闭被取消。确认结果未知时保留相同 operationId 供安全重试；已知任务重开时继续查看原 run。活动任务按既有 processPollIntervalMs 刷新摘要，完成结果按需刷新，避免进度更新重建整个图片列表。

### One presentation component serves two task adapters

从图库进度卡片提取纯展示组件，图库与导出各自映射真实状态、标题、计数、加载资产及操作。生成遮罩仅覆盖弹窗内容区，标题和关闭按钮仍可使用；规则编辑在生成时不可操作。参考页显示卡片，数据集页显示同一任务行。沿用已有主题、组件和动画，不新增依赖或图标。

### Dataset browsing is a third workbench view

将 references/execution 的布尔切换改为包含 datasets 的明确视图。列表默认当前素材集、时间倒序，包含生成中、完成与失败；支持状态和文本筛选、分页、查看与下载。详情包含概览、规则与分组、参考样本、文件与校验；桌面保留列表上下文，窄屏使用完整宽度。读取中的骨架沿用设置页样式，失败保留已读数据。

表格沿用设置页 ModelsDirectory 的主题容器、轻量表头、身份图标、主次文字、行悬停与聚焦反馈，以及右对齐的紧凑操作。搜索框、状态筛选和刷新操作处于同一水平行；窄屏收缩搜索宽度、保留固定宽度筛选，并将刷新文字收起为有标签的图标。

## Risks / Trade-offs

- 高频检查点影响存储 → 合并同阶段更新，阶段结束强制保存，不为展示进度重复执行核验。
- 请求确认前关闭造成未知结果 → store 保留请求身份，重试复用同一 operationId，拒绝自动重复启动。
- 历史参考图不可用 → 保留已授权的包元数据与文本，资源读取/下载错误明确呈现，不以当前画像代替旧包。
- 阶段计数被误读为全程耗时 → 标明当前阶段和单位，不显示推算的剩余时间。
- 当前工作区有其他未提交变更 → 实施前备份目标文件，只修改本变更必要路径。

## Migration Plan

新增私有读取与 UI，checkpoint 的导出字段为既有 JSON 扩展，不修改 ProfileExport 或 Session 格式。历史任务缺少进度时显示已知状态；完成产物从既有记录和文件推导摘要。更新匹配的 Host/Client 产物后重载服务，回滚仅恢复本次备份并重建，不重写历史数据。

## Open Questions

无决策性未决项。用户已确认按独立变更继续实施。
