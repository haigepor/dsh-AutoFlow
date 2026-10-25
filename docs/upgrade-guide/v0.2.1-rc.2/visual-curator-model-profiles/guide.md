---
kind: upgrade-guide
description: Visual Curator reference datasets add a version-two model-profile format alongside existing human-release exports.
---

# Visual Curator model reference profiles

English | [中文](guide.zh.md)

## Change

The optional Visual Curator plugin automatically adopts evidence-backed rules into immutable `modelProfile` records. Its reference-only exports use `profileExport` records and a JSON envelope with `formatVersion: 2`. These packages contain model-authored preferences and require no human publication or supervised-data split. Existing human releases, labels and version-one exports retain their original fields and behavior.

`visual_style_get` exposes `modelProfile`. Its fresh `id` can be passed as `releaseId` to search, crop and reference export operations. A model-profile export accepts `kind: style` or `skill`, `purpose: reference` and `mode: references-only`; `splitId` is omitted. Other export purposes still require the original human-release workflow.

## Migration

1. Update custom dataset readers to dispatch on `formatVersion`. Read version-two `activeRules`, `ruleSelections`, groups and model authorship from `style-profile.json`; retain existing version-one parsing. Verify every file checksum before consuming the package.
2. Update callers that use model profiles to read the exact current `modelProfile.id` and stale flag instead of inventing a release ID or requesting per-rule approval. Keep the selected ID fixed for the task.
3. Back up the profile's Visual Curator storage before downgrading the plugin. Older plugin builds do not recognize the new tagged records; restoring a matching backup is required for a downgrade. No original image files are migrated or copied.
4. Confirm that a complete analysis shows automatically selected rules and that Generate dataset downloads a version-two references-only package. Human supervision exports must continue to enforce their saved splits and reviewed labels.
