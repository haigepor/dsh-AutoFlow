---
description: "Import public articles, understand text and original images, and review editorial image prompts."
kind: "package-bundle"
---

# Article images

English | [中文](README.zh.md)

## Summary

This independent bundle imports public Google Sheets links, captures rich articles and original images through Chromium, and uses isolated DSH sessions to prepare understanding reports and image prompts. Human review is the endpoint. Generation, remote asset publication, article publication, sheet writes, OAuth and scheduling are unavailable.

## Installation and development

The CLI includes this bundle for new Web/Desktop profiles; existing profiles retain their choices. Its production dependency `article-image-toolkit` supplies the shared capture kernel. Build with `pnpm --filter dsh-plugin-article-image build:client`, test with `pnpm --filter dsh-plugin-article-image test`, and verify syntax, entries, locale parity and UTF-8 with `pnpm --filter dsh-plugin-article-image check`.

## Workflow

Import a public Google Sheets URL with link/category/language/notes mappings. Import is read-only and applies remote changes only when requested. It preserves query parameters and deduplicates within the spreadsheet/tab. Changing adopted category, language or notes invalidates approval and stops an active old analysis; moving a row alone does not invalidate approval.

Start one article or a batch. The browser retains ordered headings, emphasis, safe links, lists, quotations, tables, figures, captions and credits, excluding page furniture. Original bytes are stored separately. Inline raster images are also decoded, bounded and saved without placing Base64 in snapshots. Quality checks expose missing assets, unsupported content, incomplete pagination and uncertain boundaries. Unknown boundaries require explicit source review; known missing content cannot be approved away. Browser failure never silently falls back to a supposedly complete text result.

Qualified content proceeds automatically through understanding, optional chapter synthesis, planning and structural checks. No copying into chat is required. Every block and original image must be covered; image-bearing articles require a model with image input. References connect reports and image cards to the reader. New images are planned by content rather than replacing originals one by one.

Review the understanding and editable cards. Defaults are one cover and two inline images at 16:9, Chinese explanations and self-contained English prompts. Select quantity and ratio before a new analysis. Scene or understanding-brief changes require explicitly confirming affected prompts were updated. Saving clears approval. Approval rejects stale revisions, sources, adopted metadata and unsynchronized prompts, and never submits a generation request.

The original article illustration is shown while content is pending; captured content stays readable during analysis. Stop and Resume use the existing action toolbar. Article reading, understanding/prompts, review results and diagnostics have separate tabs. Open Diagnostics to view the current stage and elapsed time, switch between Logs and Debug data, or copy the diagnostic JSON. A transient read failure keeps loaded content readable without a page-wide banner; Debug retains a bounded error code and Refresh retries. Initial loading failures still offer Retry. Each attempt retains up to `maxRunEvents` events (default 80); older records have no retrospective trace. Records contain codes, origins, timings and counts, excluding URL paths/queries, credentials and article text. Closing a page stops subscriptions only. Stop cancels browser/model work and drains local resources. Explicit resume reuses frozen inputs and submitted checkpoints; a lost Host appears interrupted and never automatically calls a model. Polling preserves drafts; navigation requires confirmation for unsaved edits. Theme tokens, narrow screens, keyboard operation and reduced motion are supported. See [assets](assets/README.md) for artwork.

## Configuration and records

The root Cordis row validates limits in [config-schema.js](config-schema.js). Set `analysis.provider` and `analysis.model` explicitly to a configured DSH route. Token/context/image budgets, timeout, step count and concurrency are validated. Missing runtime services, model/image support or rule files prevent analysis. `maxAssetBytes` remains accepted for local asset storage; `capture.maxImageBytes` controls retrieval.

Set `network.proxyUrl` and `network.dnsProvider: cloudflare` on the root article-image row to use an existing HTTP(S) CONNECT proxy and DNS over HTTPS for browser navigation, data resources and original images. For example, `network: { proxyUrl: "http://127.0.0.1:7897", dnsProvider: "cloudflare" }`; use the actual deployment endpoint. Capture inherits this validated route unless `capture.network` is explicitly supplied. Defaults use direct connections and system DNS; proxy credentials are rejected, and public-IP pinning and redirect checks remain enabled. Keep existing analysis settings and publisher adapters when editing the profile. Sheet import and model providers retain their own transports. See the [toolkit network options](article-image-toolkit/README.md#explicit-network-routing) for limits.

`capture.adapters` declares publisher templates using `id`, exact `hosts`, `articleSelector`, optional `endSelector`, `excludeSelector`, `pendingSelector` and `expectedMinImages`. Exclusions apply only inside the selected article after access checks; pending placeholders share the render timeout after scrolling. Optional `pagination` identifies same-article pages through a stable element attribute; optional `expandSelector` permits read-only article controls. Unmatched sites require boundary review. Production navigation, redirects and resources reject private/local addresses. Isolated contexts do not reuse a logged-in profile. Browser readiness is separate from package installation.

Editorial instructions share [Skill references](skills/article-image-editorial-prompts/references/understanding.md) and [runtime rules](rules). `analysis.rulesFile` may name an absolute UTF-8 JSON file containing `version: 1` and partial `policy`. Package defaults, that file, then per-run quantity/ratio determine effective rules. Each run freezes files, hashes, policy, templates, model settings, business fields, blocks and actual image attachments. Changes affect new runs; current rule differences are displayed beside saved input.

Data lives under `$DSH_HOME/.plugins/dsh-plugin-article-image/profiles/<profile-path-hash>/`. `state.v2.json` is the small index; immutable snapshots, inputs, analyses, plans and content-addressed original bytes are separate. Atomic publication, digest checks and cross-process writer locks protect records. Legacy `state.json` stays untouched and is backed up to `legacy/state.v1.<digest>.json` before publishing a validated successor. Historical text/plans/approval stay readable but require recapture before new approval. Manual text remains a marked legacy draft and cannot assert original-image completeness.

List polling reads the index once and loads only the snapshot and plan fields required by summaries. Same-instance writes queue before the cross-process lock. Capture progress commits in batches bounded by `progressBatchSize` (default 16, range 1–200) and `progressFlushMs` (default 200 ms, range 10–3000); terminal publication drains pending events, retaining their occurrence timestamps. A progress write failure cancels capture. Diagnostics retain the operation, safe cause category and error type, including filesystem failures and writer-lock timeouts, without copying upstream messages or paths. If the terminal index cannot be written, the background job result retains the safe diagnostic.

## Model Experience

Native tools expose status, import, processing jobs, paginated paragraph projections, plan JSON pages, saves and reports; they expose no approval or generation tool. Editing an existing plan requires reading all `article_image_plan_page` fragments with the same `inputHash` and revision, joining their Unicode code-point text, and saving the complete structured plan at that exact revision. Collect `job_output` and inspect the report: a job handle or idle Agent is not a submitted plan. Tool results and original-image attachments are durable Session inputs. Each background stage permits only its task-bound submission tool. Source text, images and notes cannot enable shell, publication or approval capabilities.

The two bundled Skills share editorial references with the background runner. Structural checks do not replace semantic human review. Standalone toolkit MCP retains its schema:1 text/planning workflow and separate store; its exported `./capture` API is the rich kernel used here. Its additional `article_image_capture_source` and `article_image_source_page` tools capture and page rich sidecar snapshots without changing old records. MCP results do not imply completed workbench understanding or human approval.

## Releases and recovery

The independent updater retains its existing release source. [Release preparation](release/README.md) builds artifacts without publishing. Removing the bundle retains data. For rollback, stop the plugin, preserve the complete profile directory and run the old package against the unchanged schema:1 file or backup; old packages cannot read `state.v2.json`. See the [upgrade guide](../../../docs/upgrade-guide/v0.2.0-rc.2/article-image-workflow/guide.md).

## Known Limitations and Deferred Work

Completeness is limited to configured publisher templates and explicit review. Login/paywall/challenge pages, unsupported visual media, missing originals and exhausted budgets block analysis. Decoding accepts PNG, JPEG, GIF and WebP; unsupported formats remain visible failures. Real public-site coverage and model quality require the [acceptance procedure](../../../openspec/changes/article-image-understanding-workbench/acceptance.md); deterministic fixtures establish neither. No image-provider SDK or publication adapter is connected.

## Dev Note

None.
