---
kind: upgrade-guide
description: Visual Curator wallpaper and Codex image records require updated readers after new derivatives or task evidence are saved.
---

# Visual Curator wallpaper data

English | [中文](guide.zh.md)

## Change

Wallpaper records add the `composition` discriminator, processing metadata and versioned Run checkpoints. Updated readers preserve existing images, analyses, exports, datasets and three-node layouts. Earlier readers cannot interpret new variants; keep updated plugins after writing them. No Session-format or model-weight migration occurs.

Recoverable masked outpainting requires the matching native LLM task interface and Codex Subscription adapter. Installing Visual Curator alone into an older desktop cannot add these capabilities. Pure crop remains available; extension stops with a capability notice.

Readers preserve frozen V1–V5 plans, `wallpaper-plan-detail-v1/v2`, `wallpaper-outpaint-v3` and generation receipts. `protected-context-v2` recomposition reuses an existing generation without claiming a different mask; explicit manual corrections retain cumulative edit limits. `wallpaper-plan-v5` detail checkpoints save `detailAnalysis`; recovery creates child tasks. Current `wallpaper-plan-v6` / `wallpaper-outpaint-v4` work adds scene-specific edit prompts and ordered reference evidence.

Reference analysis supports `visual-curator-reference-v4` with V3 reads and `visual-curator-summary-v5`. `wallpaper-review-v4` requires every prior check plus clarity, with optional clarity evidence and independently reviewed super-resolution derivatives. Old reviews never count as current checks.

Direct-original batches use `wallpaper-direct-v1`, checkpoint version `2`, `wallpaper-review-source-v1` and frozen `source-faithful-v1`, without style releases, collection references or search parents. Version-one tasks and frozen style reviews remain readable; existing tasks, originals and outputs are not rewritten.

Optional wallpaper `backgroundResolution` records separate CPU super-resolution evidence. Enhanced backgrounds are derived outputs, not native high-resolution provider originals; preservation checks and independent review remain required. Historical records without this field remain unchanged.

Codex tasks add optional `evidence` and per-asset `generationId`. Explicit requested settings and provider reports remain separate from attachment pixel dimensions: requesting high quality does not turn a reported 941×1672/low result into native high resolution. Historical responses are not reconstructed. Older strict readers may reject new fields; never delete evidence to make them load.

Current configuration adds `limits.idlePollIntervalMs` (30 seconds) for idle workbench discovery. Frozen legacy configurations and active import/reference-analysis polling remain unchanged; older configuration readers may reject it.

`wallpaper.decision` and image `decisions` freeze routing limits. New tasks enable decisions; legacy tasks require opt-in.

## Migration

1. Stop the Profile and back up its data directory before testing; keep the backup separate from the live writer.
2. Use matching source desktop, Visual Curator and Codex Subscription packages for masked work. The [local workflow](../../../../custom-plugins/workspace/dsh-plugin-visual-curator/README.md#wallpaper-workflow) defines entry points and commands.
3. Open a saved search batch and start wallpaper work; confirm downstream plans, outputs, review receipts and clarity stages. Historical stages without saved clarity evidence remain unexecuted; datasets and preview searches stay available. For enhanced backgrounds, confirm separate CPU evidence and independent review.
4. For held legacy images, choose **Processing decision**; confirm its action and limits.
5. Inspect new Codex receipts: distinguish requested/reported settings from attachment dimensions; historical receipts need no backfill.
6. To downgrade after new records exist, stop the Profile and restore both its pre-test data backup and the older package. Do not delete fields or rewrite individual manifests.
