---
kind: upgrade-guide
description: Visual Curator reference datasets become reusable across conversations within one application profile.
---

# Visual Curator dataset scope

English | [中文](guide.zh.md)

## Change

Visual Curator 0.2.9 scopes automatic style profiles and completed reference datasets to their training collection and application profile. A dataset created by a conversation is selectable from other conversations and configured models in that profile. Older saved datasets retain their files and checksums and no longer require the creating Session to be selected. Collections remain separate. Application-profile isolation, private image access and Session task-log permissions remain enforced.

Users who relied on conversation boundaries to separate training datasets must use separate application profiles for that separation.

## Migration

1. Finish active tasks, update Visual Curator to 0.2.9 or a Desktop version carrying it, and restart the application. If the Desktop plugin update button fails before sending a request, update Desktop first.
2. Open the desired training collection, then **Datasets**. Existing completed full packages remain available without reanalysis or rewriting stored data.
3. Open **Find with this profile**, select the desired saved package and configured model, and start the task. The task uses that package's frozen references, rules and prompt. Observation-only packages cannot serve as the complete search standard.
4. Keep training collections that need a separate access scope in separate `dsh` profiles. No Session log, image or other profile is migrated by this update.
