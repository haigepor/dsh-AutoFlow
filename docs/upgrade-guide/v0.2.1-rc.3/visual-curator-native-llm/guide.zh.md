---
kind: upgrade-guide
description: 视觉策展的新任务默认使用已注册的原生 LLM 路由，替代插件直接请求的 HTTP 模型接口。
---

# 视觉策展原生 LLM 路由

[English](guide.md) | 中文

## 变更

视觉策展的新任务配置默认采用 `vision.backend: native`。Host 需要挂载 `llm` 和 `attachments`；只填写插件 endpoint 和凭据已不能配置默认调用。未记录 backend 的历史冻结任务保持原来的兼容 HTTP 行为，已保存观察继续可读。切换调用方式会改变 reviewer 标识，不会悄悄改写已发布标准。

## 迁移

1. 在项目的“模型”设置中配置支持图片的原生供应商及模型，凭据继续由原生凭据服务管理。
2. 在视觉策展模型设置中选择“原生 LLM”，把供应商标识填写到 `vision.provider`，把准确模型标识填写到 `vision.model`，保留模型支持的推理级别并保存。无效路由或缺少图片能力会在启动分析前被拒绝。
3. 需要继续直连 HTTP 的部署，可显式选择“兼容 HTTP 接口”，或在 profile overlay 设置 `vision.backend: compatible`。已有 endpoint 和凭据字段仍作为备用配置；失败不会自动通过两个接口重复发送。
4. 执行一次小批量分析，确认分析侧栏显示原生供应商和实际返回的用量、收到增量时展示思考及正文、最后显示一份总结。切换调用方式后，应重新生成并复核标准，再执行新的正式找图和裁剪任务；旧任务记录仍然保留。
5. Unsplash 预览默认通过 Host 返回授权图片字节，并对系统及加密 DNS 执行有界切换。可按部署需要配置 `source.unsplash.mediaDnsResolvers`，空数组会关闭外部备用解析；只有需要浏览器直连 CDN 时，才选择 `source.unsplash.previewTransport: redirect`。操作系统 DNS 与 hosts 文件不会被修改。
