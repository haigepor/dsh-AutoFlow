---
name: afp-core-news-search
description: Use DSH AFP tools for news photo search; inspect dry-run reports before any confirmed private-collection write.
---

# News photo search

## DSH workflow

1. Call afp_status to check configured credential references. Never print credentials, signed URLs or image bytes.
2. Use afp_search_plan for offline query planning and afp_collections to verify exact private collection targets.
3. Call afp_refresh for a visual dry-run. Save its runId; use job_output for progress, job_kill to stop and afp_report for the retained report. Resume using the same runId.
4. Metadata only recalls candidates; acceptance requires pixels, category hard gates and account-wide deduplication. Never weaken quality gates to fill a quota.
5. For remote changes, call afp_plan_change with append, replace or clear. Show exact collection names, removals and additions to the user. Call afp_apply only after explicit authorization and the DSH approval prompt.
6. A failed or cancelled write may be partial. Read afp_report and afp_collections, then create a new plan; never automatically retry or roll back.

Optional features can be disabled independently. If a required tool is unavailable, explain which capability must be enabled; do not launch scripts from an external repository.
