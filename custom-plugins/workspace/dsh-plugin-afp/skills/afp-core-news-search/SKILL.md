---
name: afp-core-news-search
description: Search actual AFP news photos and inspect metadata through DSH read tools; use visual dry-run reports before confirmed collection writes.
---

# News photo search

## DSH task tracking

Before the first AFP operation, call the available native todo_write tool with a concise task list in the user's language. Adapt these steps to the request: check AFP setup; search and inspect news; summarize verified results. Start one actionable item as in_progress and the rest as pending; preserve unrelated unfinished items when writing the full list. On resumption, update the existing AFP items instead of creating duplicate tasks. Explanatory questions without AFP execution need no new list. If todo_write is unavailable, report that task tracking is unavailable and continue authorized AFP work without inventing another tool.

Update the list when a real step finishes, needs retry, or the scope changes. A returned job handle does not complete visual screening: collect job_output and read afp_report first. Complete final selection only after afp_photo_selection succeeds. Failed, interrupted, or incomplete work remains unfinished; summarize the blocker instead of marking every item completed.

Use the checklist without create_goal for ordinary one-turn work, including selecting 10 photos. Consider a persistent goal only when the user requests a genuinely large resource target that requires sustained work across multiple continuation rounds, and the runtime exposes goal tools. Collection capacity, candidate count, a slow call, or a retry alone never creates a goal. Follow the current goal tool's authority and limits; read get_goal before creating one, preserve an existing goal, and do not clear or replace it automatically.

## DSH workflow

1. Call afp_status to check configured credential references. Never print credentials, signed URLs or image bytes.
2. Use afp_search_plan only for offline query planning. Start an actual caption search with afp_photo_search_start, passing query, a supported language and limit (within the tool's maximum). This first-page tool has no cursor field: for example {"query":"cat","language":"en","limit":1}. It does not translate Chinese or execute a plan's boolean/Facet instructions. When a Chinese alias is suggested, explain the actual search term before using it.
3. If hasMore is true, call afp_photo_search with the returned cursor and the same query and language. Never invent "0", "?", null or another placeholder. Legacy afp_photo_search callers can omit cursor on the first page; new searches use afp_photo_search_start. Stop on an empty page, repeated cursor or duplicate-only page; keep prior results if a read fails. After retryable:false, do not repeat unchanged input; report the error or correct the parameters before continuing. Use afp_photo_details for one photo's metadata. These results do not prove visual quality or licensing rights.
4. Only when collections are requested, use afp_collection_list for the named account-visible collection directory and afp_collection_items with collectionNextOffset for member pages. Unnamed entries are excluded and counted in meta.excludedUnnamedCount; do not treat them as shared collections for access tests. afp_collections reads only fixed category target names and counts; it is not the complete directory. Keep readOnly and writable distinctions when proposing changes.
5. Only when visual acceptance is requested, call afp_refresh with mode="start", the requested supported categories, runId=null for a visual dry-run; it uses configured category searches, not arbitrary photos from the preceding search. Save its runId; use job_output for progress, job_kill to stop and afp_report({kind:"run",id:runId}) for the retained report. Resume with afp_refresh({mode:"resume",categories:[],runId}). Never pass planId with runId; read plans via afp_report({kind:"plan",id:planId}).
6. Metadata selection is valid for ordinary search and must be labelled unverified visually. Visual acceptance requires pixels, category hard gates and account-wide deduplication. Never weaken quality gates to fill a quota.
7. For remote changes, call afp_plan_change with append, replace or clear. Show exact collection names, removals and additions to the user. Call afp_apply only after explicit authorization and the DSH approval prompt.
8. A failed or cancelled write may be partial. Read afp_report and afp_collections, then create a new plan; never automatically retry or roll back.

Read errors carry safe JSON code, stage, action, retryable and durationMs fields. Report those fields and actual response counts; do not infer successful authentication from credential presence or successful retrieval from an offline plan. New reads provide meta.durationMs; unknown errors are deliberately generic. Never request raw credentials or signed URLs for debugging.

Successful photo reads return an opaque resultRef. If nextOffset is not null, read more local metadata with afp_result_page({resultRef,offset:nextOffset,limit}); this does not request AFP again. Full safe metadata stays in plugin storage for display and selection even when the model receives a compact page. Do not read spill-file paths or repeat the AFP search to reconstruct a truncated result.

Before the final answer, call afp_photo_selection with ordered, deduplicated photoIds and criteria. For metadata selection pass basis="metadata", runId=null; use only IDs from successful reads in this Turn and state that titles/captions were screened without visual review. For visual selection pass basis="visual" and the real runId after reading afp_report({kind:"run",id:runId}) in this Turn; select only IDs kept in that report. Empty photoIds clears the final gallery. Never invent or use all-zero run IDs. Summarize the criteria and limitations in the answer; the UI renders the final image gallery and a structured table with IDs and authenticated preview links. Do not duplicate that table or invent public image URLs.

Final-answer format: use three short paragraphs in the user's language: (1) selection outcome and saved count versus the requested count; (2) screening criteria and metadata or visual basis; (3) unmet requirements or blocking errors, if any. Declare a final selection only after afp_photo_selection succeeds. If it fails, say that the final list was not saved; do not replace it with a handwritten candidate list. Copy complete canonical photo IDs exactly into tool arguments; never shorten them to provider suffixes. The UI owns the fixed gallery/table layout, so the answer must not repeat an image list or table. Do not force a success or fill a quota with rejected photos.

Tool failures expose safe code, stage, action and retryable fields. Correct conflicting parameters or missing evidence as instructed. Do not repeat identical retryable:false input; repeated failures are consolidated in the conversation with their count and original records.

Optional features can be disabled independently. If a required tool is unavailable, explain which capability must be enabled; do not launch scripts from an external repository.
