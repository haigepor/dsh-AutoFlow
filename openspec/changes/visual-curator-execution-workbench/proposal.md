## Why

风格画像能够生成，但用途创建、任务启动、Session 复核和最终入选结果尚未形成用户可操作的完整流程。画像调整后仍沿用旧匹配提示，且风格偏好全部违反时仍可能自动入选。

## What Changes

- A：复用用途记录和后台任务，增加用途分页、并发保存、只读任务准备、准备摘要检查及两步任务弹窗。
- B：复用 Session 授权和任务投影，连接会话工具卡片与工作台，明确最终入选、待复核和全部候选及终止原因。
- C：从当前启用规则生成固定执行说明，新模型画像任务采用版本化风格满足比例策略，实际裁后图片必须经过风格检查。
- 保留现有 UI 材质、颜色、间距和组件；不新增框架、任务引擎、人工标签、拖拽裁剪或批量交付。
- 新策略只作用于新模型画像任务；历史任务及人工发布版本保留其固定行为。

## Capabilities

### New Capabilities

- `visual-curator-execution`: 画像到找图裁剪的准备、执行、授权复核和固定风格判断。

### Modified Capabilities

无。仓库尚无已归档的 openspec/specs；相关历史 change 保留原值。

## Impact

范围限定 custom-plugins/workspace/dsh-plugin-visual-curator、当前 change 和该功能升级说明。复用 CuratorService、DomainRepository、UsageRevision、RunEngine、selection、现有 HTTP/Agent 适配及 DSH primitives。新增可选持久字段与请求版本保留旧记录可读，不改变 Session 格式或共享包。验证包括 owner-local 测试、Host/Client 类型检查、构建、真实浏览器夹具及编码检查。
