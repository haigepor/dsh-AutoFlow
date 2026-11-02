---
description: "Use the AFP specialist for search, visual screening, collection operations and approved downloads."
---

# AFP specialist Agent

English | [中文](agent.zh.md)

## Entry points

Choose **AFP 策展助手** in the new-conversation preset menu, or select the **AFP 图片策展** plugin from the `@` menu. Picking its plugin reference switches the current conversation to `afp-curator`; submission waits for the selection to settle. The preset name beside a conversation title also opens the switcher. Switching takes effect between turns, keeps the conversation and does not change the new-task default.

The AFP bundle must be enabled. Its existing read, refresh, write and Skill switches remain authoritative. A preset does not duplicate the shared AFP service or turn disabled capabilities back on. Credential and model configuration stays in the AFP workbench; the Agent does not request passwords or tokens in chat.

## Capability reference

| Task | Agent tools and behavior |
|---|---|
| Check setup and account | `afp_status`, `afp_account`; credential presence alone does not establish working authentication |
| Search and inspect | `afp_search_plan`, `afp_photo_search_start`, `afp_photo_search`, `afp_photo_details`; translate intent into supported search terms and keep returned cursors |
| Browse collections | `afp_collection_list`, `afp_collection_items`, `afp_collections`; named shared collections remain readable |
| Screen pixels | `afp_refresh`, `job_output`, `afp_report`, `afp_run_items`; saved decisions, reasons and resumable checkpoints |
| Final selection | `afp_photo_selection`, `afp_result_page`; current-Turn evidence, explicit final gallery and bounded result paging |
| Whole-category changes | `afp_plan_change` then `afp_apply`; append, replace or clear exact category targets |
| Exact photo changes | `afp_collection_plan` then `afp_operation_apply`; add, copy, move or remove only the specified IDs |
| Category bindings | `afp_category_plan` then `afp_operation_apply`; associate a category with one private writable collection or unbind it |
| Downloads | `afp_download_options`, `afp_download_directory`, `afp_download_plan`, `afp_operation_apply`; rendition choice, destination, cost preview and Session-owned execution |
| History and recovery | `afp_history`, `afp_diagnostics`, `afp_run_control`; paged history/trace events, pause and inactive-report archive |

The preset combines the 14 existing AFP tools with 11 scoped operation tools. Native skill loading, read-only files, questions, todo and job tools support the workflow. The original presets retain their existing tools; the additional operations belong to the AFP preset. Other global business tools are filtered from its composition.

## Working sequence

1. State the subject, quantity and intended use. For news searches, include a time range and location when relevant. The Agent loads only the matching AFP Skill and checks availability.
2. Free-text searches inspect metadata. Built-in visual screening uses the five supported categories: animals, food, landscape, movie posters and celestial wallpapers. Free-text search results are not inputs to `afp_refresh`; metadata matches must not be described as pixel-reviewed images.
3. The Agent keeps the returned job/run IDs, follows progress, reads the settled report and records the final selection. Visual final selections must use photos kept by a report read in the current Turn. `maxSelectionPhotos` defaults to 1000 independently of the search-page limit; collection and download batches remain limited to 120 photos.
4. Ask to save a subset, change a category or download selected renditions. The preview names the target, exact IDs/counts or download cost and destination label. DSH requests approval before applying the plan. A final gallery does not automatically limit a whole-category plan.
5. The Agent waits for the actual job outcome and reports completed, partial, uncertain or failed results. Quote changes require a new choice and preview; unknown write outcomes require inspection before any new plan.

Examples: “Find 20 landscape candidates; show the metadata matches first.” “Screen 30 animal photos visually and show why each was kept.” “Add only my selected photos to collection X.” “Move these three photos from A to B.” “Show rendition sizes and credit cost before downloading.”

## Composition and state

`cordis.patch.yml` declares `afp-curator` through the existing preset registry. Its persona gives workflow routing and critical limits; the six existing AFP Skills supply detailed search/category rules. `agent.js` registers scoped tools and global-tool filtering. The root `AfpService` continues to own authentication, category workflows, reports, downloads and collection mutations for both UI and Agent callers.

Operation previews are expiring, one-use and Session-owned. Collection approval captures account, names and membership; execution checks them again inside the collection write lock. The same approval cannot admit two concurrent operations. Download confirmations and signed URLs stay inside the Host downloader. Native AFP jobs retain their invoking Session; switching presets does not move ownership to another conversation.

Custom operation previews are ephemeral. After a Host restart or relevant capability change, create a fresh preview. Saved visual reports and the recorded preset remain durable. Visual calls still use the AFP plugin's configured vision route, independently of the conversation model.

## Verification limits

Keyless fixtures exercise the real Loader, preset composition, Session loop, browser entry points and native AFP operations against deterministic AFP responses. They establish local integration behavior; real AFP authentication, paid vision quality, live purchases and production membership changes require the user's configured account and explicit operation approval.
