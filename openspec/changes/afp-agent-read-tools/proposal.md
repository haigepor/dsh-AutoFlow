## Why

AFP 页面已能实际搜索和读取图片，但 Agent 只有离线搜索规划及固定分类收藏夹统计，导致会话测试无法完成真实搜索与分页。统一的操作错误也隐藏了参数、认证和读取失败之间的差异。

## What Changes

- 在现有 `read` 功能中增加实际图片搜索、详情、完整收藏夹列表和收藏夹成员分页工具，复用插件 Host 的读取实现。
- 新工具只输出允许的图片元数据、分页状态及调用耗时；凭据、签名链接和图片字节留在 Host。
- AFP Agent 工具失败返回固定错误码、阶段、重试建议和耗时；保留旧工具名称及成功结果。
- 更新插件 Skill、说明和会话快照，使离线规划与真实搜索有明确的调用流程。

## Capabilities

### New Capabilities

- `afp-agent-read-tools`: Agent 真实搜索、图片详情、收藏夹浏览及安全错误反馈。

### Modified Capabilities

无。

## Impact

实现限定于 `custom-plugins/workspace/dsh-plugin-afp/`；独立记录位于本 change。复用现有认证、取消、功能开关和 Host 数据转换，不修改 DSH 核心、公共 API、页面布局或写入确认流程。中文转换、高级搜索、任意图片视觉筛选及下载恢复作为后续独立阶段。
