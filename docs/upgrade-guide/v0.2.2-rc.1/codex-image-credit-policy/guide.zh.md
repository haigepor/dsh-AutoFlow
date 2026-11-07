---
kind: upgrade-guide
description: Codex 生图不再把 allowCredits 作为图片请求开关。
---

# Codex 生图账号策略

[English](guide.md) | 中文

## 变更

Codex 订阅插件此前在所有可用账号均为 `allowCredits: false` 时拒绝生图。现在生图使用已启用、授权有效的账号，由图片后端判断权益与额度。`allowCredits` 继续控制已知订阅窗口耗尽后的本地文字调度，不是图片计费选项；图片计费遵循账号及工作区策略。

## 迁移

1. 更新 Codex 订阅插件，现有账号设置与已保存图片任务无需数据迁移。
2. 若此前依赖 `allowCredits: false` 阻止生图，请停止图片工作流或停用对应账号。此开关不再阻止图片派发。
3. 对此前的 `IMAGE_CREDITS_DISABLED` 失败明确提交新任务，更新不会自动重发历史任务。确认新任务已到达图片后端，并保留实际结果或上游错误。
