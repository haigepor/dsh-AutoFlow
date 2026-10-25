---
kind: upgrade-guide
description: Visual Curator 来源设置新增 Unsplash Provider 和相互独立的账号凭据引用。
---

# Visual Curator Unsplash 账号

[English](guide.md) | 中文

## 变更

可选 Visual Curator bundle 在校验配置中新增 `source.provider` 和 `source.unsplash`。已有 JSON 来源解析为 `generic` 并保留映射。“模型&图库设置”页面可以通过 DSH 凭据保存多个网页会话并浏览账号收藏夹。来源标识 `unsplash` 使用明确选定的账号搜索全站；`defaultAccountId` 为 `null` 时使用公开搜索。

账号会话值不属于配置或任务 JSON。旧构建加载由当前构建保存的 profile 时，会拒绝这些新设置字段。

## 迁移

1. 已有 JSON 来源配置无需修改。接入 Unsplash 时，在“模型&图库设置”中点击“添加账号”，到独立的官网窗口登录，验证后的账号会自动连接。“高级设置”通过弹窗打开原 JSON 来源。
2. 设置 `source.provider: unsplash` 并选择 `source.unsplash.defaultAccountId`，或使用页面的默认来源操作。来源调用方传入 `sourceId: unsplash`；已有八个 Agent 工具及固定风格输入继续可用。
3. 将 `source.unsplash.accounts` 的账号描述与其引用的凭据值分开保存。确保系统 curl 和 Chrome 或 Edge 可用。`source.unsplash.curlBinary` 选择 curl；`source.unsplash.login.browser` 选择 `auto`、`msedge` 或 `chrome`，`login.executablePath` 可指定其他已安装程序。Host 需要图形会话。登录使用临时浏览器配置目录，不读取或复制个人浏览器配置。不要将账号 Cookie 文件复制到分发的插件包中。
4. 降级前备份 profile 配置与凭据，选择通用来源，并从保存的 Provider 配置中移除 `source.provider` 和 `source.unsplash`。启动旧构建前，确认原来源端点及凭据引用仍然正确。
