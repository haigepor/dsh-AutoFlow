## Why

AFP 图库、详情、清单和下载弹窗目前分别请求相同的预览，重复展示会重复传输图片并进行远端认证。复用已加载的预览可减少等待，但必须隔离账号、控制内存并正确释放组件资源。

## What Changes

- 在当前 AFP 插件中新增独立的内存预览缓存模块，共享成功的栅格 Blob、并发请求和正在使用的对象 URL。
- 增加条目数、Blob 字节数、有效期的部署配置，使用 LRU 淘汰；失败和取消不缓存，重试可绕过坏条目。
- 组件独立取消；最后一个消费者退出才取消共享请求。凭据、连接、读取权限和 Host 实例变化时清空旧缓存。
- 用离线测试与可重复基准验证请求复用、生命周期和容量控制，更新插件文档。

## Capabilities

### New Capabilities

- `afp-preview-memory-cache`: 当前 AFP 页面内的预览复用、配置、失效和资源管理。

### Modified Capabilities

无。

## Impact

只修改 `custom-plugins/workspace/dsh-plugin-afp` 与本次 OpenSpec 记录。Host 仅扩展插件部署配置和私有页面状态元数据；Agent 工具输出、DSH 公共接口、项目其他模块保持原有行为。不增加依赖，不持久保存图片，不缓存付费原图、报价、凭据或签名 URL。
