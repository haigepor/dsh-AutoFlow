---
kind: upgrade-guide
description: Visual Curator reviews complete provider canvases for source fidelity and blocks approval, recomposition and export of every source or candidate overlay mode.
---

# Source framing and generated wallpapers

English | [中文](guide.zh.md)

## Change

New practical direct batches use `source-intent-v2`: source medium, framing, visible entities and preservation requirements are frozen. Partial or close-up non-automobile primaries require `layoutFocus`; full visible rectangles remain the preservation reference. Minimum size retention defaults to 0.9 and compares the longer bounding-box dimension in V2. Uncertain evidence stays pending. Partial views and occlusion never authorize unseen anatomy; reconstruction still requires a whole damaged primary or critical entity and frozen `repair-when-needed` authorization.

New `wallpaper-edit-input-v6` binds the positioned canvas, original, safety guide and alpha mask. V2 centers the primary subject within feasible original framing; only vacant background is editable. Saved requests remain unchanged. Update the plugin before reading V6 or `source-framing-review-v1` records.

New `subject-fill-v1` tasks save action prop IDs and check relative layout. Reading them requires this update.

`source-framing-review-v1` saves source observations, incompatible limits, annotations and bounded native-crop evidence before generation. Source-only `reinspect` may correct geometry without changing identities, roles or preservation requirements. Uncertain or incompatible framing remains unapproved without anatomy changes or safety relaxation. Explicit recovery of historical pre-placement failures creates a continuation, preserving its parent, accepted images and spent budgets.

Generated wallpapers use `generated-canvas-v1`: the complete provider result, with no source or candidate overlay. `source-intent-background-v1`, `source-edge-v1`, `protected-context-v1/v2`, `generated-canvas-protected-v2` and `background-plate-v1/v2` remain viewable history but cannot be recomposed, approved or exported as generated wallpapers. `wallpaper.processing.sourcePreservation` cannot enable them. Independent review compares actual output against the source for framing, appearance, relationships, medium, seams and perspective.

`practical-v2` requires full safe-area containment for cars and critical structures, 97% for other main subjects, and separate fine-extremity assessment. Each co-primary needs a separate core or explicit absence report; missing boxes recover same-image review, not generation. Pure crops remain supported. Historical policies remain frozen, and recorded passes cannot approve overlays. Strict admission remains unchanged; accepted high-resolution originals reuse validated archives. Key routes disable neural reconstruction; subscriptions may reconstruct small outputs.

Source-intent replanning returns only `imageVersionId`, `editPrompt` and `reason`; Host retains frozen source facts. Explicit continuations adopt this protocol. Historical partial-view plans without a focus stop before generation; start a new batch to observe it.

## Migration

1. Preserve task records, source files and generation receipts. Start a new practical direct batch for source-intent observation and review; existing tasks are not migrated or marked passed. Configure `wallpaper.sourceIntentPolicy.minimumSubjectScaleRatio` before creation when a value other than 0.9 is required.
2. Existing owner-authorized `wallpaper-continue` actions with `completeCanvas: "current"` or `practical: "current"` and a new `operationId` retain their existing scope, parent history and spent edits; they do not add source-intent policy.
3. Keep default `wallpaper.processing.reviewStages: final-only-v1`, or select `native-and-final-v1` when both reviews are required.
4. Confirm the new task's frozen policy, `generated-canvas-v1` composition mode and independent final review before export. Inspect the actual complete generated image; do not reuse a source-overlay artifact. Query unknown remote outcomes using their saved receipt before another dispatch.
