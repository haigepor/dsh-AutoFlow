---
name: afp-core-search-collections
description: Search actual AFP photos and browse account-visible collections through DSH read tools; inspect dry-run reports before confirmed writes.
---

# Search and collections

## DSH workflow

1. Call afp_status to check configured credential references. Never print credentials, signed URLs or image bytes.
2. Use afp_search_plan only for offline planning. Start an actual caption search with afp_photo_search_start, passing query, a supported language and limit (within the tool's maximum). This first-page tool has no cursor field: for example {"query":"cat","language":"en","limit":1}. It does not translate input or execute plan Facets, boolean expressions or date filters. Do not claim image results from planning alone.
3. If hasMore is true, call afp_photo_search with the returned cursor and the same query and language. Never invent "0", "?", null or another placeholder. Legacy afp_photo_search callers can omit cursor on the first page; new searches use afp_photo_search_start. Stop on an empty page, repeated cursor or duplicate-only page; deduplicate by photo ID. After retryable:false, do not repeat unchanged input; report the error or correct the parameters before continuing. Read one photo using afp_photo_details; found false means AFP returned no matching record.
4. Use afp_collection_list for all named account-visible collection metadata, then afp_collection_items with collectionId and the returned nextOffset to browse member pages. Unnamed entries are excluded and counted in meta.excludedUnnamedCount; do not treat them as shared collections for access tests. Preserve permission fields; reading a shared collection does not authorize writing it. Use afp_collections only to check fixed category targets and counts. Do not substitute similarly named collections for an exact target.
5. Call afp_refresh for a supported category visual dry-run when requested; it uses configured category searches rather than arbitrary preceding results. Save its runId; use job_output for progress, job_kill to stop and afp_report for the retained report. Resume using the same runId.
6. Metadata only recalls candidates; acceptance requires pixels, category hard gates and account-wide deduplication. Never weaken quality gates to fill a quota.
7. For remote changes, call afp_plan_change with append, replace or clear. Show exact collection names, removals and additions to the user. Call afp_apply only after explicit authorization and the DSH approval prompt.
8. A failed or cancelled write may be partial. Read afp_report and afp_collections, then create a new plan; never automatically retry or roll back.

Tool errors expose fixed JSON code, stage, action, retryable and durationMs fields; new read successes expose meta.durationMs. Invalid arguments require correction, authentication errors require checking setup, and only explicitly retryable reads can be retried. Keep successful pages after a read failure. Report unavailable tools as blocked rather than inventing results; never return raw credentials, signed links or upstream error bodies.

Optional features can be disabled independently. If a required tool is unavailable, explain which capability must be enabled; do not launch scripts from an external repository.
