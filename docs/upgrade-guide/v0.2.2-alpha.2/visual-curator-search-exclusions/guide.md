---
kind: upgrade-guide
description: "New Visual Curator search exclusions and preview configuration require the updated plugin reader."
---

# Visual Curator search exclusions and previews

English | [中文](guide.zh.md)

## Change

New searches save exact reference and prior-selection exclusions in `fixed.searchExclusions`, with exclusion decisions in their checkpoints. Unsplash photos use stable provider and photo IDs across accounts and resized URLs; local images also use verified byte digests. Previously qualified images in the same authorized collection and known references are skipped before visual review. Existing tasks without this policy keep their original behavior, including when resumed. Historical matches are not rewritten.

Preview concurrency is configured separately from search budgets at `source.unsplash.previewConcurrency`, an integer from 1 to 4 with default 2. Saved task configuration includes this field. Older strict plugin readers cannot read all newly saved configurations and exclusion checkpoints.

## Migration

1. Finish active work, update the Visual Curator Host and client together, restart DSH, then refresh the page. Keep the updated reader for tasks created after this update. No manual data-directory edits are required.
2. Start a new search to apply the frozen exclusions. Check `excludedNegative`, `excludedReference` and `excludedPrevious` in its saved counts; excluded images spend no visual-review calls. Retrieval and downloads already performed still consume their original budgets. An existing or resumed task does not acquire later reference changes.
3. Keep the default preview concurrency unless deployment conditions require another value. Load the image grid and verify task controls stay responsive while images load. Full previews and model-review URLs retain their original resolution; grid thumbnails use a smaller representation.
