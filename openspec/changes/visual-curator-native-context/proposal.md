## Why

视觉策展的原生调用仍用插件输出上限覆盖模型页配置，导致上下文容量为 1M 的模型在生成 8,192 token 后终止。大素材集归纳也没有接入项目现有的上下文压缩策略。

## What Changes

- 新原生任务继承注册模型的上下文容量、输出默认值和推理默认值，并记录实际调用参数。
- 为原生 Compaction 服务增加无 Session 副作用的文本输入压缩能力，复用模型策略、计量与 LLM 调用。
- 在归纳请求前按原生策略压缩观察文本；保留人工判断、图片身份和结构化输出要求，压缩请求计入原任务预算并持久化。
- **BREAKING**：新原生任务不再使用插件的输出上限与推理覆盖；历史冻结任务和备用 HTTP 保留原行为。

## Capabilities

### New Capabilities

- `visual-curator-native-context`: 原生模型参数继承、有界观察文本压缩及任务记录。

### Modified Capabilities

无。

## Impact

涉及视觉策展 Host、模型选择页、原生 Compaction 定义与 Basic 实现、对应测试和使用文档。不修改 Agent loop、已有 Session 或持久化事件格式；不恢复已取消任务。
