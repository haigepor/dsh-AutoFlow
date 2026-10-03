## Context

The AFP workbench currently keeps selected photo DTOs in one client store, but does not record their source collection. Gallery images open details on click, the collection heading only opens the selection pane, and the client exposes only the Mockup preview route. `AfpService` already admits unowned profile jobs that survive view closure; its current status includes active jobs only. AFP-Image documents `getPhoto.downloadableMedias`, `buyPhoto`, `getUrls`, and a short-lived media URL, while its downloader handles already-deliverable media. The plugin has no owned download or collection-membership removal flow.

## Goals / Non-Goals

**Goals:**

- Make favorite-image selection, detail, sidebar, and batch operations usable across collection changes.
- Download all AFP-provided renditions through a Host-owned task with explicit per-batch credit confirmation.
- Keep AFP tokens, media keys and signed delivery URLs out of the browser, persistent results and logs.
- Preserve completed or interrupted download outcomes and use the project's UI tokens and primitives.

**Non-Goals:**

- Delete AFP photos or entire selections.
- Add a DSH core API, a new dependency, restart-surviving downloads, or browser automation.
- Automatically retry an ambiguous purchase request or infer an order-validation value from `requestId`.

## Decisions

- **Selection and origin:** Keep `selectedPhotos` as the photo map used by gallery and detail components. Add a separate `photoSources` map from photo ID to the set of favorite collection IDs in which it was selected. Collection changes do not clear either map; removing a photo from the selection clears its source collection records. Host operations re-read selection ownership and membership instead of trusting the client map.
- **Image actions:** A normal gallery image click toggles selection; right-click opens details and suppresses the browser menu. The title remains a keyboard-accessible detail button. The selection marker uses an existing project SVG icon. Reports keep their review-specific behavior.
- **Favorite writes:** Use the existing `write` feature flag and require private selections for all targets and every source being changed. Copy adds the documents to the target. Move first adds and verifies the target membership, then removes the document IDs from writable source selections using `delete-selection-docs` with `deleteAll: false`. Removing from favorites only removes membership. Never call `DELETE /delete-selection/{id}`. Disable move/removal if any source is missing, shared or read-only; report partial outcomes without rolling back already verified additions.
- **Download protocol:** Extend the AFP Host client with Hub GraphQL reads for each photo's `downloadableMedias`, confirmed purchases, and safe delivery downloads. Return only rendition label, dimensions, estimated size and cost to the page; retain `mediaKey`, `validateOrderId`, tokens and delivery URLs in Host state. A paid batch uses a short-lived server-side plan and one-use confirmation token. Re-fetch media metadata and balance at confirmation; require another confirmation if the total or availability changed. Require the existing `write` feature for paid purchases. A 202 purchase response is accepted, not proof that bytes are ready. Re-read `getPhoto.downloadableMedias` and use an AFP-returned `href` only when it is present. Although AFP-Image records `getUrls`, its response fields and correlation with the purchase are not verified, so the plugin does not call it or substitute `buyPhoto.requestId` for `validateOrderId`. If delivery state is unclear, record a pending result and do not buy again.
- **File handling:** Pick the destination through the Host's composed DSH directory-picker capability and keep the selected absolute path in Host memory under an opaque short-lived ID. Verify the directory before starting. Stream bytes to a unique temporary file, enforce a deployment `maxDownloadBytes` limit, validate an allowed raster signature, and rename atomically. Use a bounded `downloadConcurrency` setting. On collision, append a numeric suffix. Prefer a trustworthy response filename; otherwise use GUID then AFP ID with the media extension. Apply sanitized prefix/suffix options to the basename only.
- **Background status:** Schedule through existing `ctx.jobs`. The task continues across tab/view changes and ends when the profile Host is disposed. Persist small per-batch records under the AFP profile for queued/running/completed/partial/failed/cancelled/interrupted state, counts and output basenames; omit absolute paths, credentials, media references and signed URLs. Mark an orphaned running record interrupted when status loads after a process restart.
- **UI:** Keep the collection toolbar fixed above the independently scrolling gallery. Show up to four selected thumbnails with an overflow count, selection count and project icon actions. Use existing `Button`, `Tooltip`, `Modal`, `Input`, `Tag` and DSH directory picking; use theme tokens for hover, spacing, border, focus and animation. Respect reduced-motion settings.
- **Download feedback:** Fill the Modal's available padded height, keeping header and confirmation footer fixed. Wide screens have independent quality/settings scroll areas; narrow screens share a scrolling body. Use project `StateDot` for the active button stage and structured row skeletons for the initial quote. Register one profile store subscriber in `shell.overlay`; a submission toast offers a progress action and a screen-edge control remains folded by default. The nonmodal card uses shared outside-pointer dismissal, Escape with focus restoration, and inert hidden controls. Persisted Host counts replace the temporary accepted batch; resets clear global feedback and invalidate outstanding cancellation responses.
- **Batch quality:** Compact photo rows show one metadata/cost line and a short quality trigger; its menu retains complete rendition quotes. A toolbar icon opens the project Menu with highest-free, highest-available and exact AFP quality-label choices. Each choice shows the number of eligible matching photos. Rank each photo's own renditions by pixel area, then file size and lower cost; exclude unavailable and write-disabled paid media. Exact-label choices do not reuse a rendition ID across photos or infer a quality family from arbitrary text. Apply matching IDs in one store update, preserve unmatched choices and invalidate the reviewed quote. Quote reload, individual edits and profile reset clear batch feedback.
- **Collection navigation:** Use compact project Button rows and shared `GlideHighlight`, with folder glyphs, a single-line truncated name and quiet count. Show permission Tags for read-only/shared entries; private writable rows omit the repeated label but retain it in the accessible name.

- **Photo presentation:** Gallery cards use equal 4:3 frames across loading, decoded and error states, displaying complete images at their original proportions with necessary letterboxing; detail and toolbar previews keep their own geometry. The selection summary toggle folds the drawer, which omits a duplicate header close button; row removals appear on hover or keyboard focus, always remain visible on touch, and never clear other selections. Project Buttons expose selection through pressed state, a compact circular SVG check, hover and keyboard focus. Action tooltips use short localized text and a 180px cap; accessible button names retain full photo titles. One drawer toggle groups three complete thumbnails, overflow, a count Tag and an expansion indicator; download and relationship actions remain separate.

## Risks / Trade-offs

- [Risk] `buyPhoto` returns HTTP 202 and AFP-Image does not establish a durable `requestId` to order-row mapping or a verified `getUrls` response → Re-read AFP media state and use only a returned `href`; persist unresolved outcomes and never issue an automatic second purchase.
- [Risk] AFP may partially apply a multi-photo transfer or download batch → Process each photo independently, verify destination membership before source removal, persist per-photo outcomes and keep failed rows retryable without repeating a completed purchase.
- [Risk] Host-local paths differ from browser-local paths in remote deployments → Store files on the DSH Host selected by its directory picker and label the destination as the Host location.
- [Risk] A large source image can exhaust memory or disk → Stream to disk, bound concurrency and per-file size, check available write errors, and remove incomplete temporary files on cancellation.

## Migration Plan

No existing AFP state or public API changes. New download records use a separate profile subdirectory and schema version. Existing profiles require no migration. If the work fails, remove the new operation routing and UI while leaving any completed downloaded files and outcome records intact.

## Open Questions

None. The unresolved AFP transaction correlation is handled by refusing to guess or retry; interface behavior remains bounded and testable without a live credit purchase.
