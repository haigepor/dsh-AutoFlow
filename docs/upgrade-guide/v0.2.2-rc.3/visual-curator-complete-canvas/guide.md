---
kind: upgrade-guide
description: Visual Curator no longer recomposes or exports source-restoring generated wallpapers as approved outputs.
---

# Complete generated wallpapers

English | [中文](guide.zh.md)

## Change

Generated wallpapers use the complete provider canvas. The Host no longer pastes source or candidate pixels over a generated background. Saved tasks using `source-edge-v1`, `protected-context-v1`, `protected-context-v2`, `generated-canvas-protected-v2` or `background-plate-v1/v2` remain readable, but their generated outputs cannot be recomposed or exported as approved wallpapers. Pure crops remain supported. `wallpaper.processing.sourcePreservation` no longer enables source restoration.

New direct batches use `practical-v2` acceptance and one compact final-output review. Cars, including peripheral parts, and critical structures must be fully inside the safe area; other main subjects require at least 97% containment. Fine natural extremities are assessed separately. Each frozen co-primary ID needs its own `subject/core` region or an explicit absent-subject report; missing boxes require same-image review recovery, not generation. `subject/peripheral` cannot represent another object or excuse a car part outside the safe area. Natural background variation remains allowed; source-pasted output remains prohibited. Saved `practical-v1` tasks retain their frozen rules until explicit current-policy adoption. `version: strict-v1` retains strict admission. Key routes disable neural super-resolution; subscription routes may reconstruct small outputs.

High-resolution sources already accepted within the 20 MiB upload limit reuse archived originals or validated blobs during reference preparation. Larger normalized PNGs do not trigger another upload-limit rejection; source quality is preserved.

## Migration

1. Preserve existing task records and source files. Do not clear storage or discard generation receipts.
2. Start a new direct batch, or use the owner-authorized `wallpaper-continue` action with `completeCanvas: "current"` and a new `operationId`. The continuation retains history and edit counts, replaces pasted attempts and rechecks existing complete generated outputs.
3. To adopt practical-v2 for saved outputs, call `wallpaper-continue` with `practical: "current"` and a new `operationId`. The child reclassifies subjects once from the original, then reviews each earliest usable complete output. Parent records, earlier roles, versions, receipts and spent edits remain intact; previous acceptance does not establish the new containment requirements.
4. Set `wallpaper.processing.reviewStages` to `native-and-final-v1` only when both native and final reviews are required; otherwise use the `final-only-v1` default.
5. Confirm the latest generated attempt uses `generated-canvas-v1`, inspect the actual output for collage boundaries and duplicate objects, and export only after final review passes. Unknown remote outcomes must be queried using their saved receipt before another dispatch.
