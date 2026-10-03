---
name: afp-core-news-search
description: Search actual AFP news photos and inspect metadata through DSH read tools; use visual dry-run reports before confirmed collection writes.
---

# News photo search

## DSH workflow

1. Call afp_status to check configured credential references. Never print credentials, signed URLs or image bytes.
2. Use afp_search_plan only for offline query planning. Start an actual caption search with afp_photo_search_start, passing query, a supported language and limit (within the tool's maximum). This first-page tool has no cursor field: for example {"query":"cat","language":"en","limit":1}. It does not translate Chinese or execute a plan's boolean/Facet instructions. When a Chinese alias is suggested, explain the actual search term before using it.
3. If hasMore is true, call afp_photo_search with the returned cursor and the same query and language. Never invent "0", "?", null or another placeholder. Legacy afp_photo_search callers can omit cursor on the first page; new searches use afp_photo_search_start. Stop on an empty page, repeated cursor or duplicate-only page; keep prior results if a read fails. After retryable:false, do not repeat unchanged input; report the error or correct the parameters before continuing. Use afp_photo_details for one photo's metadata. These results do not prove visual quality or licensing rights.
4. Use afp_collection_list for the named account-visible collection directory and afp_collection_items with nextOffset for member pages. Unnamed entries are excluded and counted in meta.excludedUnnamedCount; do not treat them as shared collections for access tests. afp_collections reads only fixed category target names and counts; it is not the complete directory. Keep readOnly and writable distinctions when proposing changes.
5. Call afp_refresh for a supported category visual dry-run only when requested; it uses configured category searches, not arbitrary photos from the preceding search. Save its runId; use job_output for progress, job_kill to stop and afp_report for the retained report. Resume using the same runId.
6. Metadata only recalls candidates; acceptance requires pixels, category hard gates and account-wide deduplication. Never weaken quality gates to fill a quota.
7. For remote changes, call afp_plan_change with append, replace or clear. Show exact collection names, removals and additions to the user. Call afp_apply only after explicit authorization and the DSH approval prompt.
8. A failed or cancelled write may be partial. Read afp_report and afp_collections, then create a new plan; never automatically retry or roll back.

Read errors carry safe JSON code, stage, action, retryable and durationMs fields. Report those fields and actual response counts; do not infer successful authentication from credential presence or successful retrieval from an offline plan. New reads provide meta.durationMs; unknown errors are deliberately generic. Never request raw credentials or signed URLs for debugging.

Optional features can be disabled independently. If a required tool is unavailable, explain which capability must be enabled; do not launch scripts from an external repository.
