## Context

视觉策展使用独立 Run，原生 Compaction 当前只处理 Session。插件明确覆盖 maxTokens；模型设置中的上下文容量由同一路由的 prepareCall 返回。当前工作区已有其他修改，必须保留。

## Goals / Non-Goals

目标是继承原生模型参数、按原生策略压缩归纳观察，并保持请求可重建、预算有界、取消有效。范围不含修改 Session、恢复取消任务、改变模型配置或自动切换供应商。

## Decisions

- 新任务通过 vision.useModelDefaults 标记参数继承；resolveConfig 保留历史省略语义，resolveCurrentConfig 为新原生任务启用。prepareCall 不覆盖 maxTokens 或 reasoningEffort，使用同一注册代返回的 context。
- CompactionEngine 增加 compactInput；Basic 实现复用 resolveTargetPolicy、resolveCompactSpec、TokenMeter 和原生 prepareCall。其他后端明确报告不支持，不静默跳过压力处理。
- 工作台复用可见的 profile 压缩服务；Web 的 preset 隔离服务不可见时，在插件私有作用域挂载 Basic 后端并固定 auto=false。可通过插件 compaction 字段传入原生 Basic 策略；显式配置使用私有实例，不修改聊天实例。
- 只压缩归纳输入的观察文本块。Schema、完整图片 ID、正反例角色与人工判断留在固定输入中；摘要属于模型推断，不能覆盖人工事实。没有压力时零额外调用。
- 每次压缩通过调用者提供的执行入口进入 RunEngine.request，在主归纳调用前执行，避免持有视觉并发令牌时嵌套等待。所有请求仍受总调用、截止时间、响应字节和取消约束。已提交压缩结果可以重放。
- 压缩不接受缺少终止块、截断、无文本或不能缩短的输出；单个不可压缩块或固定部分超限明确失败，已保存观察保持可用。

## Risks / Trade-offs

- 摘要可能损失细节 → 原始观察保留，固定人工证据不压缩，模型收到保留不确定性和反例的要求。
- 输出默认值可能过大或未声明 → 如实继承并记录，不将上下文容量当作输出上限，不虚构供应商能力。
- 历史配置含旧上限 → 仅新任务继承默认值，旧快照继续执行原参数。

## Migration Plan

构建后重载插件；新任务使用模型页参数，HTTP 配置与历史记录不迁移。回退到本轮文件备份并重新构建；保留已提交的数据与请求记录。

## Open Questions

无。
