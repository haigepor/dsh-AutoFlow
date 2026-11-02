---
kind: upgrade-guide
description: "Visual Curator automatic search datasets and frozen negative references require an updated Host and client."
---

# Visual Curator search datasets

English | [中文](guide.zh.md)

## Change

New search launches can use `autoPrepareDataset` instead of an explicit `datasetId`. The native conversation is created before a missing complete style package is prepared. That accepted human launch can save the complete package to the collection library for reuse. Negative-only observation packages supplement the current complete package; they cannot replace its style rules or make an older complete package match the current profile.

New launches include current negative observations by default. Their deduplicated observations, judgments and eligible negative-package sources are frozen at admission and included in the conversation attachment. Already admitted tasks retain their original input. Saved launch records and responses can contain `negativeReferences` and the `preparing-dataset` stage, which older plugin readers do not support.

## Migration

1. Finish active tasks, update the Visual Curator Host and client together, restart DSH, then refresh the page. No data-directory edits or reanalysis are required.
2. Custom launch clients can pass `autoPrepareDataset: true` when omitting `datasetId`. Check the `automaticDatasetPreparation` and `negativeReferenceDatasets` capabilities first, and retain the accepted operation ID when retrying. Explicit packages must still match the current profile.
3. Start a new search without a current complete package. Confirm that the conversation opens during package preparation, then continues searching; reopen the dataset list to see the reusable complete package. The form shows the deduplicated negative-reference count separately.
4. Keep the updated reader when reopening newly saved launches. Existing accepted launches are not retroactively supplemented with negative observations.
