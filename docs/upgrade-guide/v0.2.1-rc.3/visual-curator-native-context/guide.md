---
kind: upgrade-guide
description: Visual Curator native tasks inherit model controls and use native input compaction.
---

# Visual Curator native context settings

English | [中文](guide.zh.md)

## Change

New native tasks inherit the registered model context capacity, output and reasoning defaults. Plugin output limits no longer override them. The profile Compaction service compresses observation text before induction when native pressure policy requires it; every compression call counts toward the task budget. Existing frozen tasks and explicit compatible HTTP retain their old controls.

## Migration

1. Set context capacity and output defaults on the selected image-capable model in Settings → Models; these are separate values.
2. Keep the native token meter enabled. Visual Curator reuses a visible Compaction backend or mounts an isolated native Basic instance when chat owns its own scope. Optional `compaction` settings use the native Basic policy fields. Select and save the model; new native configurations use `vision.useModelDefaults: true`.
3. Start a new small analysis and inspect its saved native request: capacity and controls must match the selected route. Existing failed snapshots keep their original limit and are not migrated in place.
4. Keep `vision.backend: compatible` for deployments using HTTP output overrides. A missing native compaction service, invalid capacity or failed summary reports an error and retains saved observations.
