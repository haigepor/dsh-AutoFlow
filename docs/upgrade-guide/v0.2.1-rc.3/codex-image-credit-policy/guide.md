---
kind: upgrade-guide
description: Codex image requests now exclude accounts that disable additional credits.
---
# Codex image spending policy

English | [中文](guide.zh.md)

## Change

The Codex subscription plugin previously applied `allowCredits: false` only to text requests. Image requests now exclude these accounts because the image backend has no verified subscription-only spending control. If every otherwise eligible account disables credits, image tasks fail before dispatch with `IMAGE_CREDITS_DISABLED`. Existing images remain readable; text quota rules are unchanged.

## Migration

1. In Models → ChatGPT subscription, review the additional-credits switch for the account intended for image generation. Enable it only when additional spending is acceptable, or keep it disabled and use another image provider.
2. Generate one image with an enabled account to confirm access. A disabled account must return `IMAGE_CREDITS_DISABLED` without dispatch; enabling credits does not itself grant image entitlement.
