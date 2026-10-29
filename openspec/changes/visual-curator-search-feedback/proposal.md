## Why

Visual Curator 将图库不提供原图、下载失败和视觉复核问题混成通用警告，聊天中缺少真实进度，且启动提示容易让 Agent 在尚无交付时查找不存在的目录。需要先修复这些诊断与交付提示，再让用户在对话和工作台直接掌握任务结果。

## What Changes

- 记录可定位到候选和处理阶段的安全诊断，区分原图不可用、技术失败、待复核和视觉不通过；仅最终复核通过才计入合格。
- 交付目录只从已提交的交付回执展示，启动指令明确目录创建条件，避免要求提前扫描预计目录。
- 使用原生组件重做紧凑工具卡和工作台详情；对话中的进度与结果来自已授权 Run，而非模型叙述。
- 将原生 TodoPanel 移入当前会话 body 右上角的悬浮胶囊，保留计数、详情和键盘操作，窄容器隐藏。

## Capabilities

### New Capabilities

- `visual-curator-search-feedback`: 真实候选诊断、任务卡、对话实时进度、结果分类及故障恢复。
- `conversation-todo-capsule`: 会话 body 内的任务胶囊、响应式隐藏与多会话隔离。

### Modified Capabilities

- `visual-curator-session-search-launch`: 未交付前的目录语义及按真实交付回执报告路径。

## Impact

影响 Visual Curator 的图库来源、搜索、投影、工具返回和客户端展示，以及 ui-conversation 的 TodoPanel 和 body 插槽。不修改 Agent loop、全局配置、运行中的用户数据或任务预算；不调用付费接口。旧归档改动与本变更分别隔离提交，不推送。
