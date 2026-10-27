---
kind: upgrade-guide
description: "New Visual Curator model-profile tasks enforce current rule coverage instead of accepting every preferred-rule failure."
---
# Visual Curator task preparation and style matching

English | [中文](guide.zh.md)

## Change

New model-profile search and crop tasks compile current enabled rules and require final style coverage. The default limits.minStyleMatchRatio is 0.75; unknown evidence requires review. Edited profiles no longer execute old matching prompts or automatically reuse old search hints. Existing tasks and human-published releases retain their saved behavior. New recipe fields and request versions do not support resuming new tasks with an older plugin.

## Migration

1. Open the workbench, select a current profile and create or select an output usage. Use Check task before Start finding images, or call visual_task_prepare before the existing start tools.
2. Supply explicit retrieval keywords when old analysis hints no longer describe your adjusted rules. Configure limits.minStyleMatchRatio for new tasks only; it describes rule coverage, not probability.
3. Use saved selection membership rather than a pass verdict to identify deliverables. Open Session tasks through their tool card and original authorization channel.
4. Finish or cancel new tasks before downgrading. Preserve stored data; do not rewrite old recipes or resume new-policy tasks with an older plugin. Confirm that final selections and stopping outcomes match the workbench counts.
