---
description: "Read-only article imports and reviewable editorial image prompts for AutoFlow."
kind: "package-bundle"
---

# Article images

English | [中文](README.zh.md)

## Summary

This independently versioned bundle imports public Google Sheets article links, extracts article text, and lets a conversation Agent save realistic editorial image plans for workbench review. Google Sheets remains read-only. Image generation, uploads, private-sheet OAuth and scheduled execution are not connected.

## Installation and development

The CLI ships this bundle; new Web/Desktop profiles enable it. Existing profiles retain their bundle choices. Enable Article images in Plugins, or use `pnpm dsh plugin --profile web add file:<absolute-package-directory>`. Headless and SDK profiles do not enable it by default. Build with `pnpm --filter dsh-plugin-article-image build:client`, test with `pnpm --filter dsh-plugin-article-image test`, and inspect syntax, entries and encoding with `pnpm --filter dsh-plugin-article-image check`.

## Workflow

Open Article images from the main sidebar and choose Import articles in the compact header. Its native modal contains the public Google Sheets URL and URL/category/language/notes header mappings; optional mappings may be empty. Import results and errors stay in the modal. Import retains source rows and business fields, inherits blank categories, reports invalid URLs, and deduplicates by spreadsheet/tab and URL while preserving query parameters. Reimport updates source metadata without replacing saved article text or plans. Remote source changes are applied only by an explicit import.

Select articles and fetch their text. Retrieval starts with the configured native web provider. An enabled size recovery makes one anonymous native HTTP attempt only for oversized responses or successful truncated HTML; it preserves public-address and same-origin redirect checks. Access denials, login/challenge pages, unsupported content, network failures and timeouts have separate errors. Supply a title and complete text manually when needed. Text and source pages are untrusted data; HTML is parsed without executing scripts or loading resources. Reading a title is not reading the article.

Copy the Agent instructions into a conversation. The two bundled Skills guide the Agent to read every saved paragraph page and save its understanding plus image prompts. Defaults are one cover and two inline images at 16:9, with Chinese explanations and English final prompts. Counts and ratios can be edited. Each image references real paragraph numbers and records its relevance, subject, action, environment, composition, lighting, colors, style, details and avoidance constraints. Review and approve in the workbench; approval never generates an image. Saving an edit invalidates approval, and stale source hashes or revisions are rejected.

The workbench uses the shared Button, Input, Checkbox, Menu, Modal, Tooltip, SegmentedControl and AnimatedCollapse primitives. Semantic colors and motion tokens follow the active theme, including reduced motion. The task sidebar collapses to a 56px rail on desktop and a compact header on narrow screens without removing its controls or losing list position. Article metadata, tabs and contextual actions share a compact reading header. Retrieval status appears within the article rather than in a separate global job strip. Search filters the current page; category filtering and pagination read the Host. Unsaved plan or manual-text edits require confirmation before article navigation. The generated transparent Logo and theme-colored SVG artwork are documented in [assets](assets/README.md).

## Configuration and records

The root Cordis row validates source defaults, column mapping, row/text/byte limits, request timeout, retrieval concurrency, pagination and polling. See `config-schema.js` for accepted fields. Tools, workbench and Skills are independently selectable bundle features. Skills register directly with the runtime registry and do not overwrite Home files.

Raw HTML limits differ from extracted article length. Size recovery defaults to `retryLargeHtml: true`, `maxArticleHtmlBytes: 8000000`, and `maxArticleHtmlChars: 2000000`; these limits affect only that anonymous HTTP attempt. Disable recovery when all requests must use the selected provider. `articleUserAgent` and `maxRedirects` also apply to recovery. Both network attempts share the `requestTimeoutMs` deadline; cancellation and timeout still drain local cleanup. `maxArticleElements` defaults to 50000; `maxArticleChars` caps saved text at 100000 characters. Neither changing these limits nor using a browser proves completeness.

Records live below `$DSH_HOME/.plugins/dsh-plugin-article-image/profiles/<profile-path-hash>/state.json`, outside installed package files. Atomic replacement and cross-process writer locks protect commits; paths reject user-controlled links. Closing a view does not cancel jobs. Stopping a task or unloading the plugin aborts and drains retrieval. Queued edits and imports are cancelled on unload; commits already underway drain before disposal returns; an abandoned process leaves an interrupted record available for explicit retry. Records and plans persist across package updates. No credentials or image bytes are stored in these records. The plugin does not publish an invariant companion because its records and views share one authoritative store rather than independently owned observations.

## Model Experience

The Agent sees native tools, two bundled Skill summaries, and requested saved article paragraphs through durable tool results. Skills load on demand. Article text and saved plan fields consume request tokens only when returned or submitted; there is no independent background model call or hidden article injection. Tool metadata supports generic replayable result cards. Image generation is reported unavailable rather than simulated.

Collect the background fetch job through native `job_output` before reading its report; results identify the actual retrieval method and whether size recovery ran. The status tool returns a batch limit derived from `toolResultBytes` so a terminal result retains every item's outcome. The report includes source URLs, retrieval time and bounded source notes. Read paragraph pages by `sourceHash` until `nextOffset` is null. Each page fits both `articlePageChars` and the complete JSON byte budget. A failed refresh can retain earlier text, but its failed state/error remains visible and prevents saving a new plan until retrieval or manual replacement succeeds.

## Releases and recovery

The bundle declares the existing GitHub updater source and keeps its version independent from AutoFlow. [Release preparation](release/README.md) produces a tarball, checksum and exact-version metadata without publishing. Updates require restart. Disabling or removing the bundle retains local records; reinstalling an older package does not undo data changes. Preserve the state file before manual recovery.

## Known Limitations and Deferred Work

Article extraction uses [Mozilla Readability](https://github.com/mozilla/readability) with an inert [jsdom](https://github.com/jsdom/jsdom) document and cannot establish that a publisher delivered complete content. Recognized login/challenge pages and restricted teasers are rejected; unrecognized or client-rendered pages can still require manual text. There is no browser execution, CMS adapter or external scraping service. Manual text is explicitly identified. Source relevance remains an editorial judgment rather than a guaranteed automated score. Real image-provider submission, uncertain-request reconciliation, local image downloads, budgets, sheet writes and remote image uploads require their own adapters and verification.

## Dev Note

None.
