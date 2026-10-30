---
kind: upgrade-guide
description: Codex 生图请求现在会排除禁止使用额外积分的账号。
---
# Codex 生图消费策略

[English](guide.md) | 中文

## 变更

Codex 订阅插件此前仅对文字请求应用 `allowCredits: false`。生图请求现在也会排除这些账号，因为图片后端没有已验证的“仅用订阅”消费控制。如果其他条件满足的账号全部禁止积分，图片任务会在派发前返回 `IMAGE_CREDITS_DISABLED`。已有图片仍可读取，文字额度规则不变。

## 迁移

1. 在模型 → ChatGPT 订阅中检查用于生图的账号是否允许额外积分。仅在接受额外消费时开启，否则保持关闭并使用其他图片提供商。
2. 使用已启用账号生成一张图片，确认访问权限。禁止积分的账号应返回 `IMAGE_CREDITS_DISABLED`，且不派发请求；开启积分本身不会授予生图权益。
