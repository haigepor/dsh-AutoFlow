---
name: afp-core-visual-triage
description: Use DSH AFP tools for visual triage; inspect dry-run reports before any confirmed private-collection write.
---

# Visual triage

## DSH workflow

1. Call afp_status to check configured credential references. Never print credentials, signed URLs or image bytes.
2. Use afp_search_plan for offline query planning. For an ordinary request to find pictures, call afp_photo_search_start with query, language and limit, continue with returned cursors, deduplicate IDs and screen metadata. Do not read fixed category collections or start visual refresh unless the user requests visual acceptance or collection operations. Check only the relevant collection targets when needed.
3. Only when the user requires visual acceptance, start afp_refresh with mode="start", the requested supported categories, runId=null. It searches the configured category policy rather than arbitrary preceding results. Save the returned real runId; inspect job_output, stop with job_kill, and read afp_report({kind:"run",id:runId}). Resume with afp_refresh({mode:"resume",categories:[],runId}). Read write plans with afp_report({kind:"plan",id:planId}); never combine report kinds or invent IDs.
4. Metadata selection is valid for ordinary search and must be labelled unverified visually. Visual acceptance requires pixels, category hard gates and account-wide deduplication. Never weaken quality gates to fill a quota.
5. For remote changes, call afp_plan_change with append, replace or clear. Show exact collection names, removals and additions to the user. Call afp_apply only after explicit authorization and the DSH approval prompt.
6. A failed or cancelled write may be partial. Read afp_report and afp_collections, then create a new plan; never automatically retry or roll back.

Successful photo reads return an opaque resultRef. If nextOffset is not null, read more local metadata with afp_result_page({resultRef,offset:nextOffset,limit}); this does not request AFP again. Full safe metadata stays in plugin storage for display and selection even when the model receives a compact page. Do not read spill-file paths or repeat the AFP search to reconstruct a truncated result.

Before the final answer, call afp_photo_selection with ordered, deduplicated photoIds and criteria. For metadata selection pass basis="metadata", runId=null; use only IDs from successful reads in this Turn and state that titles/captions were screened without visual review. For visual selection pass basis="visual" and the real runId after reading afp_report({kind:"run",id:runId}) in this Turn; select only IDs kept in that report. Empty photoIds clears the final gallery. Never invent or use all-zero run IDs. Summarize the criteria and limitations in the answer; the UI renders the final image gallery and a structured table with IDs and authenticated preview links. Do not duplicate that table or invent public image URLs.

Final-answer format: use three short paragraphs in the user's language: (1) selection outcome and saved count versus the requested count; (2) screening criteria and metadata or visual basis; (3) unmet requirements or blocking errors, if any. Declare a final selection only after afp_photo_selection succeeds. If it fails, say that the final list was not saved; do not replace it with a handwritten candidate list. Copy complete canonical photo IDs exactly into tool arguments; never shorten them to provider suffixes. The UI owns the fixed gallery/table layout, so the answer must not repeat an image list or table. Do not force a success or fill a quota with rejected photos.

Tool failures expose safe code, stage, action and retryable fields. Correct conflicting parameters or missing evidence as instructed. Do not repeat identical retryable:false input; repeated failures are consolidated in the conversation with their count and original records.

Optional features can be disabled independently. If a required tool is unavailable, explain which capability must be enabled; do not launch scripts from an external repository.
