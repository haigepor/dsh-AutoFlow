---
name: afp-curation-celestial-wallpaper
description: Use DSH AFP tools for celestial wallpaper curation; inspect dry-run reports before any confirmed private-collection write.
---

# Celestial wallpaper curation

## DSH workflow

1. Call afp_status to check configured credential references. Never print credentials, signed URLs or image bytes.
2. Use afp_search_plan for offline query planning and afp_collections to verify exact private collection targets.
3. Call afp_refresh with categories=["celestial-body-wallpaper"] for a visual dry-run. Save its runId; use job_output for progress, job_kill to stop and afp_report for the retained report. Resume using the same runId.
4. Metadata only recalls candidates; acceptance requires pixels, category hard gates and account-wide deduplication. Never weaken quality gates to fill a quota.
5. For remote changes, call afp_plan_change with append, replace or clear. Show exact collection names, removals and additions to the user. Call afp_apply only after explicit authorization and the DSH approval prompt.
6. A failed or cancelled write may be partial. Read afp_report and afp_collections, then create a new plan; never automatically retry or roll back.

Optional features can be disabled independently. If a required tool is unavailable, explain which capability must be enabled; do not launch scripts from an external repository.

## Visual acceptance contract

- `spherical-body`: a planet, moon, or sun must span at least 80% of the shorter image edge.
- `extended-formation`: nebulae, galaxies, comets, and black holes may be non-spherical, but astronomical content must cover at least 60% and empty black background must be at most 40%. Black-hole interiors and star-textured darkness are not empty background.
- `dense-star-field`: scattered stars are allowed only when the model classifies them as `dense`, cosmic texture covers at least 75%, and empty black is at most 40%; sparse deep-field/catalog images are rejected.
- Return only `presentation=wallpaper`. Reject flat scientific solar-disc observations, terrestrial night landscapes, and sparse deep fields even when a coverage threshold is otherwise met. A space station or satellite may be a secondary detail, never the dominant composition.
- All decisions are pixel-only. Ignore AFP watermark/credit/ID overlays and AFP viewer or metadata UI; judge the underlying picture instead. Do not use title, caption, keywords, OCR, or a Codex Vision MCP as visual evidence. Use the configured OpenAI-compatible vision provider through `afp-core-visual-triage`.
