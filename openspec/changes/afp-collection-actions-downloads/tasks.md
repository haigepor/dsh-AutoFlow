## 1. AFP protocol and operation contracts

- [x] 1.1 Verify the documented AFP `downloadableMedias`, buy, delivery URL, and selection membership fields against the vendored client and AFP-Image records; record unsupported purchase correlation explicitly
- [x] 1.2 Define and validate plugin-private request/result DTOs for collection operations, rendition quotes, confirmation plans, destination selection, and persisted download results
- [x] 1.3 Add Host AFP client operations for rendition metadata, safe purchase/delivery progression, and favorite membership add, verify, and unlink

## 2. Host background download service

- [x] 2.1 Add Host directory selection backed by the composed DSH directory-picker capability and retain destination paths only in Host memory
- [x] 2.2 Implement a one-use, short-lived download quote confirmation plan that rechecks balance and renditions before any paid purchase
- [x] 2.3 Implement streamed, bounded-concurrency file saving with signature/size checks, temporary files, safe filenames, and collision handling
- [x] 2.4 Schedule downloads through `ctx.jobs`, support cancellation and progress, and persist concise per-batch outcomes without secrets or absolute paths
- [x] 2.5 Add Host collection copy, move, and unlink operations with writable-source checks, target verification, and per-photo partial results
- [x] 2.6 Extend Host status and routing to expose download records and operation results while keeping credential and signed-URL fields Host-only

## 3. Workbench interaction and collection navigation

- [x] 3.1 Add cross-collection selection provenance to the client store and preserve selections across collection changes
- [x] 3.2 Change photo card interactions to click-select and right-click-details, with a keyboard-accessible details control and SVG selection marker
- [x] 3.3 Redesign the searchable, collapsible favorite sidebar and fixed collection selection toolbar using project tokens and components
- [x] 3.4 Add modal flows for unlink, copy, and move, including destination choice, progress and partial failure feedback
- [x] 3.5 Add download setup modal for directory, rendition choices, balance/total confirmation, filename affixes, and live filename previews
- [x] 3.6 Surface background download progress, cancellation, and recent persisted outcomes in the task area
- [x] 3.7 Improve the back-to-top hover/focus styling and respect reduced-motion preferences

## 4. Localization and documentation

- [x] 4.1 Add Chinese and English locale strings for collection actions, download setup, progress, errors, and confirmation copy
- [x] 4.2 Update plugin README documentation for Host directory semantics, credit confirmation, job lifetime, and safe purchase behavior
- [x] 4.3 Document public-to-plugin-private operation and persistence behavior in source JSDoc where required

## 5. Regression coverage

- [x] 5.1 Test selection toggling, right-click details, cross-collection provenance, and read-only action restrictions
- [x] 5.2 Test copy/move/unlink ordering, target verification, and partial failures without deleting photos or collections
- [x] 5.3 Test quote totals, balance/availability changes, one-use confirmation, ambiguous purchase handling, and no purchase before confirmation
- [x] 5.4 Test filename sanitization, fallback extensions, collisions, streaming limits, cancellation, partial results, and secret/path redaction
- [x] 5.5 Test active and persisted download status across workbench view changes and interrupted Host restart state
- [x] 5.6 Run the plugin checks, focused tests, build, UTF-8 checks, and strict OpenSpec validation; update the installed plugin without starting a browser

## 6. Download dialog recovery and presentation

- [x] 6.1 Use an opaque theme surface, compact photo/quality rows, collapsible filename options and a fixed cost/action footer
- [x] 6.2 Add safe localized stage errors and option retry; keep unknown totals unset and permit partial photo availability
- [x] 6.3 Abort stale option reads, preserve the destination on retry, and invalidate reviewed plans after destination changes or changed quotes
- [x] 6.4 Share filename sanitation between Host and preview, preserving dotted stable identifiers and custom suffixes
- [x] 6.5 Run focused regressions, plugin tests, build/check and encoding validation; verify the updated running Host through authenticated read-only requests

### Verification for section 6

`npm test` passes all 94 tests, including the recorded keyless Session. `npm run build:client`, `npm run check`, named README translation pairing and strict OpenSpec validation pass. The plugin check covers syntax, shipped files and UTF-8; Chinese and English client dictionaries have matching keys. No browser is started; visual acceptance and the native directory chooser remain user checks. Paid purchases are tested with simulated responses only.

The running Host initially rejects valid `download-options` requests with HTTP 400 `invalid-request`, while the same account/photo succeeds through the current read-only AFP client. Its module watch roots are empty. Before restarting, authenticated session/job reads show no running sessions or jobs. After package refresh and `dsh web --no-open` restart, collection list/items and download options return HTTP 200; one photo returns HighRes, MidRes and Mockup renditions and an available balance. The live served AFP client contains the exact rebuilt client bytes, and seven installed runtime/client files match their source bytes. No live purchase or download is submitted.

The scoped files are `src/client/afp-download-dialog.js`, `afp-workbench.js`, `afp-client-store.js`, client locales, `assets/workbench.css` and generated `client.js` for presentation/state; `src/shared/afp-download-filenames.js`, `src/host/afp-downloads.js`, `afp-service.js` and `index.js` for safe filenames and failures; download/client regression tests, both READMEs and their pairing record for verification and usage. Pre-edit files are backed up under `C:\Users\haige\AppData\Local\Temp\afp-download-redesign-7VdkrS`; unrelated working-tree edits remain intact.

## 7. Full-height setup and global download feedback

- [x] 7.1 Fill the available Modal height with independent quality/settings scrolling on wide screens and a fixed confirmation footer
- [x] 7.2 Match quote skeletons to photo rows, distinguish option/directory/review/submission button loading, and respect reduced motion
- [x] 7.3 Notify accepted downloads through the shell overlay and provide a collapsed edge control for progress and cancellation across page navigation
- [x] 7.4 Keep the progress card keyboard accessible, dismiss it on outside click or Escape, and suppress stale cancellation feedback after profile reset
- [x] 7.5 Align collection navigation with project Button rows, folder icons, exceptional permission Tags, quiet counts and shared GlideHighlight
- [x] 7.6 Run regression, build, encoding, locale and OpenSpec checks; refresh the installed client and verify served bytes without opening a browser

### Verification for section 7

`npm test` passes 102 tests, including the keyless Session case, download state/reset regressions, button loading, collection folding and global progress presentation. The final overlay changes pass its three focused tests. `npm run build:client`, `npm run check`, named README translation pairing, scoped whitespace checks and strict OpenSpec validation pass. Visual layout, native directory selection and actual downloads remain user checks; no browser is opened and no live purchase or download is submitted.

Before refreshing the installed package, authenticated Host status reports zero active AFP tasks and downloads. The supported profile plugin remove/add commands refresh the local package. An authenticated HTTP request verifies that the live AFP bundle includes the exact rebuilt client bytes; nine installed client/source/style/locale files match their source bytes. The shared loading, dismissal and glide APIs exist in the project primitive exports; primitives are bundled dependencies rather than independent boot entries.

Changed files for section 7:

- `src/client/afp-download-dialog.js` and `assets/workbench.css`: full-height setup, responsive scrolling, skeletons, stage-specific spinners and theme-aware progress card styling.
- `src/client/afp-download-overlay.js`, `afp-client-entry.js` and `afp-client-store.js`: one global notification/progress registration, collapsed edge access, cancellation and stale-response suppression across navigation and profile reset.
- `src/client/afp-workbench.js`: compact project sidebar rows and shared hover/focus highlight; selection, search and folding remain available.
- Client locale dictionaries, generated `client.js`, four client test files, both READMEs and `README.i18n.yaml`: localized controls, shipped bundle, behavior coverage and usage documentation.
- This change's `design.md`, image download specification and `tasks.md`: updated presentation and acceptance requirements.

Scope is limited to AFP client code and its existing change record; Host purchase, download, directory and persistence APIs are unchanged. Pre-edit source/client/test/README files are backed up under `C:\Users\haige\AppData\Local\Temp\afp-download-dock-xvr3cK`. To revert section 7, restore those files, remove the new overlay module and its test, remove the section 7 documentation additions, rebuild the AFP client and refresh the installed profile package. Unrelated edits remain intact.

## 8. Compact download rows and batch quality selection

- [x] 8.1 Redesign photo rows with one metadata/cost line, a compact quality trigger, full quotes inside the menu and matching responsive skeleton geometry
- [x] 8.2 Add project icon actions and Tooltip for quote refresh and a portaled batch quality Menu with free, highest and exact-label choices and per-choice matching counts
- [x] 8.3 Match each photo's own opaque rendition ID, retain unmatched selections, obey write/loading restrictions and invalidate the reviewed quote atomically
- [x] 8.4 Run focused and package regression tests, build/check, locale/encoding/README pairing and strict OpenSpec validation; update the installed client and verify live bytes without opening a browser

### Verification for section 8

`npm test` passes 109 tests. New tests cover per-photo ranking and opaque-ID matching, blocked and unavailable choices, retained unmatched selections, atomic review invalidation, loading guards, batch Menu activation/dismissal and compact triggers retaining complete quotes. `npm run build:client`, `npm run check`, named README translation pairing, scoped whitespace checks and strict OpenSpec validation pass. Both client dictionaries contain the same 354 keys; all 17 scoped text files decode as strict UTF-8 without BOM or replacement characters and end with one newline.

Authenticated Host status reports no active AFP task or download before the supported profile plugin remove/add refresh. HTTP verification confirms the service provides the exact rebuilt client bytes, and nine installed runtime/style/locale files match source bytes. Visual layout and menu behavior remain user checks; no browser is started and no live purchase or download is submitted.

Changed files for section 8:

- `src/client/afp-download-dialog.js`, `afp-selector.js`, `afp-client-entry.js` and `assets/workbench.css`: compact responsive photo rows, complete quality menus, batch/refresh project icon actions and matching skeletons.
- `src/client/afp-download-qualities.js` and `afp-client-store.js`: shared per-photo quality ranking, local atomic batch updates, write/loading restrictions and review invalidation.
- Client locale dictionaries, generated `client.js`, `tests/download-dialog.test.js` and `tests/download-qualities.test.js`: localized feedback, shipped bundle and behavioral regression coverage.
- Both READMEs, `README.i18n.yaml` and this change's design, download specification and tasks: usage and acceptance records.

Scope is limited to AFP client behavior; Host operations, purchase confirmation, job lifetime and stored download formats are unchanged. Originals are backed up under `C:\Users\haige\AppData\Local\Temp\afp-bulk-quality-pXTKbS`, preserving repository-relative paths. Restore those files and remove the new quality helper/test to revert this section, then rebuild the client and refresh the installed profile package. Unrelated edits remain intact.

## 9. Complete gallery images and selection controls

- [x] 9.1 Replace the outlined selected marker with a theme-aware project Button, a solid check background, pressed state, Tooltip and hover/keyboard access
- [x] 9.2 Let decoded gallery frames follow each original image ratio without cropping or fixed-frame letterboxing; retain bounded detail and summary thumbnails
- [x] 9.3 Group three complete thumbnails, overflow, a count Tag and expansion glyph in one selection drawer control, preserving separate batch actions
- [x] 9.4 Verify selection propagation, right-click details, cross-collection source records and summary overflow; update the owner-local presentation snapshot
- [x] 9.5 Run package tests, build/check, UTF-8, README pairing and strict OpenSpec validation; refresh the installed client and verify served bytes without opening a browser

### Verification for section 9

`npm test` passes 110 tests, including pressed selection, prevention of a duplicate parent toggle, source collection retention, right-click details, summary overflow and drawer toggling. The owner-local photo-selection snapshot records localized labels, pressed state, project variants and icon size. `npm run build:client`, `npm run check`, named README translation pairing, scoped whitespace/UTF-8 checks and strict OpenSpec validation pass. Actual visual layout, keyboard focus and light/dark appearance remain user checks; no browser is opened and no live AFP purchase or download is submitted.

Authenticated Host status reports zero active AFP tasks and downloads before the supported profile plugin remove/add commands. An authenticated HTTP request returns 200 and verifies the exact rebuilt AFP client inside the live served bundle, revision `ecaf326f837b`. Five installed runtime client/source/style files match their source bytes.

Changed files for section 9:

- `src/client/afp-workbench-gallery.js`, `afp-client-entry.js` and `assets/workbench.css`: project check glyph, accessible selection buttons, natural gallery image proportions, theme/focus states and reduced-motion-aware fades.
- `src/client/afp-workbench.js`: one compact selection summary with complete thumbnails, count and overflow; existing download and relationship actions remain available.
- `tests/collection-presentation.test.js` and `tests/fixtures/photo-selection.json`: behavioral coverage and the owner-local presentation snapshot.
- Generated `client.js`, both READMEs and `README.i18n.yaml`: shipped UI and paired usage documentation.
- This change's design, collection specification and tasks: presentation and acceptance records.

Scope is limited to AFP client presentation and local selection controls. Host APIs, media transport, purchases, jobs and persisted formats are unchanged. Gallery row heights now vary with each image's original proportions; toolbar/detail previews retain bounded frames. The pre-edit files are backed up under `C:\Users\haige\AppData\Local\Temp\afp-gallery-fit-Tuhu9V`, preserving repository-relative paths. Restore those files, rebuild the client and refresh the installed profile package to revert this section; unrelated edits remain intact.

## 10. Equal-height gallery cards and quiet selection removals

- [x] 10.1 Restore equal 4:3 gallery frames for loading, decoded and failed previews, preserving complete images with necessary letterboxing and aligned title/provider rows
- [x] 10.2 Style the drawer close control as a compact neutral project Button with Tooltip, focus and theme states
- [x] 10.3 Reveal row removals on hover or keyboard focus, keep them visible on touch and preserve independent close/detail/remove behavior
- [x] 10.4 Add behavioral coverage and an owner-local drawer presentation fixture, run tests/build/check and paired documentation/encoding/OpenSpec checks
- [x] 10.5 Refresh the installed AFP client and verify exact live bytes without opening a browser

### Verification for section 10

`npm test` passes 111 tests. The five focused collection presentation tests pass after adding the owner-local drawer snapshot, including close-without-clearing, opening a row's details and removing only one selection. `npm run build:client`, `npm run check`, named README translation pairing, scoped whitespace/UTF-8 checks and strict OpenSpec validation pass. The gallery image proportions are preserved inside equal frames; portrait and landscape images can have different surrounding letterboxing. Browser visual, keyboard and theme checks remain the user's manual checks.

Authenticated Host status reports zero active AFP tasks and downloads before the supported profile plugin remove/add commands. An authenticated HTTP request returns 200 and contains the exact rebuilt client, revision `340ff7e254db`; three installed runtime files match their source bytes. No browser, live purchase or paid download is used.

Changed files for section 10:

- `src/client/afp-workbench-gallery.js` and `assets/workbench.css`: equal preview frames, fixed loading/error geometry, compact close control, row hover/focus removal controls and touch targets.
- `tests/collection-presentation.test.js` and new `tests/fixtures/selection-pane.json`: close/detail/remove isolation and localized presentation snapshot.
- Generated `client.js`, both READMEs and `README.i18n.yaml`: shipped client and paired current behavior.
- This change's design, collection specification and tasks: equal-height and drawer-control acceptance.

Scope is limited to AFP client presentation. This section supersedes section 9's variable-height gallery treatment; images remain complete inside shared 4:3 frames. Host APIs, preview transport and cache behavior remain unchanged. Originals are backed up under `C:\Users\haige\AppData\Local\Temp\afp-selection-controls-CDGPoF`. Restore those files, remove the new drawer fixture, rebuild the client and refresh the profile plugin to revert this section. Unrelated edits remain intact.

## 11. Compact photo markers and action tooltips

- [x] 11.1 Replace the large filled badge with a 20px circular check and 12px project SVG while retaining a larger accessible Button target
- [x] 11.2 Keep photo action tooltips short, cap their width at 180px and align removal bubbles to the action edge; retain full titles in accessible names
- [x] 11.3 Remove the selection drawer header close button and its obsolete props/styles; retain the summary toggle for folding without clearing selections
- [x] 11.4 Update focused behavior and owner-local fixtures, run package tests/build/check and documentation/encoding/OpenSpec gates
- [x] 11.5 Refresh the installed client and verify exact live bytes without opening a browser

### Verification for section 11

`npm test` passes 111 tests; the five focused presentation tests also pass. They cover short tooltip labels, absent header dismissal, independent detail/removal actions and drawer toggling through the summary. Updated owner-local photo and drawer fixtures preserve accessible names and record the compact glyph and control variants. `npm run build:client`, `npm run check`, named README translation pairing, scoped whitespace/UTF-8 checks and strict OpenSpec validation pass. Appearance, theme and keyboard runtime checks remain user checks.

Authenticated Host status reports zero active AFP tasks and downloads before the supported profile plugin remove/add commands. An authenticated HTTP request returns 200 and contains the exact rebuilt client, revision `79ec1bf23b0e`; four installed runtime files match source bytes. No browser, live purchase or paid download is used.

Changed files for section 11:

- `src/client/afp-workbench-gallery.js`, `afp-workbench.js` and `assets/workbench.css`: compact marker, short tooltips, header close removal and caller cleanup. Equal-height frames from section 10 remain.
- `tests/collection-presentation.test.js` and both selection presentation fixtures: updated behavioral and accessible output assertions.
- Generated `client.js`, paired READMEs and `README.i18n.yaml`: shipped client and current usage.
- This change's design, collection specification and tasks: current control requirements.

Scope is limited to AFP client presentation; Host APIs, caches, purchase flow, job lifetime and persisted formats are unchanged. Originals are backed up under `C:\Users\haige\AppData\Local\Temp\afp-compact-selection-A6lYVt`. Restore those files, rebuild the client and refresh the profile plugin to revert this section. Unrelated edits remain intact.
