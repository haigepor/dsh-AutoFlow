---
kind: upgrade-guide
description: Codex image admission no longer treats allowCredits as an image-request switch.
---

# Codex image account policy

English | [中文](guide.zh.md)

## Change

The Codex subscription plugin previously rejected image requests when every eligible account had `allowCredits: false`. Image requests now use enabled, authorized accounts and let the image backend determine entitlement and quota. `allowCredits` still controls local text scheduling after known subscription windows are exhausted. It is not an image billing option; image billing follows the account and workspace policy.

## Migration

1. Update the Codex subscription plugin. Existing account settings and saved image tasks require no data migration.
2. If you relied on `allowCredits: false` to stop images, stop the image workflow or disable its account. The switch no longer blocks image dispatch.
3. Explicitly submit a new task for an earlier `IMAGE_CREDITS_DISABLED` failure. Updating does not resubmit saved tasks automatically. Confirm that the new task reaches the image backend and retains its actual result or upstream error.
