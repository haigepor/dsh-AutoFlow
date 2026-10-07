# Maintaining AutoFlow when updating upstream

English | [中文](maintaining-autoflow-fork.zh.md)

## Summary

Use this guide to compare AutoFlow customizations with an upstream update before resolving conflicts. Record exact revisions, review behavior by owner, regenerate derived catalogs, and verify the assembled application. Package READMEs remain the authority for each feature; this guide owns the update procedure and the comparison map.

## Table of Contents

- [1. Record the comparison revisions](#1-record-the-comparison-revisions)
- [2. Review the customization map](#2-review-the-customization-map)
- [3. Resolve changes by behavior](#3-resolve-changes-by-behavior)
- [4. Validate the merged application](#4-validate-the-merged-application)
- [5. Update the maintenance record](#5-update-the-maintenance-record)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

<a id="1-record-the-comparison-revisions"></a>

## 1. Record the comparison revisions

The official repository is [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), whose default branch is `master` at this guide's baseline. AutoFlow publishes `main`; `origin/deepseek-harness` is its upstream mirror. Verify both remote URLs and branch names again when updating; the mirror may lag the official repository.

For each update, the comparison baseline is the AutoFlow tip before the customization series and the previously verified upstream mirror tip. Record their exact identifiers in the update's commit or pull-request description, where historical references belong; this guide links maintained branches rather than embedding repository commit identifiers.

1. Start from a clean checkout and record the current AutoFlow tip, the old upstream tip, the proposed official tip, and their merge base. Preserve local profile files separately; Git cannot recover them.
2. Fetch the verified remotes. Review the official changes between the old and new upstream tips separately from the AutoFlow changes between the merge base and the current `main` tip.
3. Create an update branch from the recorded AutoFlow tip. Apply the official update there and resolve conflicts without overwriting the working `main` branch.
4. Preserve a checkpoint before conflict resolution. If verification fails, return to that checkpoint rather than rewriting the published history.

Read-only commands used to inspect this checkout:

```sh
git remote -v
git rev-parse HEAD origin/main origin/deepseek-harness
git merge-base HEAD origin/deepseek-harness
git diff --name-status origin/deepseek-harness...HEAD
git log --oneline origin/deepseek-harness..HEAD
```

<a id="2-review-the-customization-map"></a>

## 2. Review the customization map

For each affected owner, compare its implementation, locale dictionaries, tests, expected output, and README together. The following requirements name the behavior to retain; preserve upstream improvements that satisfy them instead of retaining an entire old file.

| Owner and documentation | Behavior to retain | Review points |
|---|---|---|
| [Settings shell](../../packages/client/ui-settings-general/README.md), [settings services](../../packages/client/ui-settings/README.md) | Full-page settings, grouped navigation, collapsed icon rail, localized search and return navigation; no bottom configuration-file area. | `SettingsPage`, `SettingsNavIcon`, `search.ts`, registration consumers, focus restoration, unloaded sections, disposal. |
| [Theme](../../packages/client/ui-theme/README.md) | Shared page geometry; mode, palette, font, corner and motion choices; legacy font selections remain readable. | `ThemeSettingsPage`, `PalettePreview`, theme-owned variables, locale keys, persisted preference compatibility. |
| [Sidebar](../../packages/client/ui-sidebar/README.md), [layout](../../packages/client/ui-layout/README.md), [official brand](../../packages/client/ui-brand-official/README.md) | Compact aligned icons, a single brand identity contribution, consistent collapse timing and Windows title-bar behavior. | Brand slots, layout tracks, rail labels, right sidebar transitions and workspace indentation. |
| [Models](../../packages/client/ui-settings-models/README.md) | Matching initial skeleton, retained refresh drafts, compact model controls, stable tag/delete overlay, provider rail and fixed settings-page actions. | `ModelsSection`, `ProviderEditor`, `ModelsSkeleton`, disclosure focus, small screens and both themes. |
| [Models reset](../../packages/client/ui-settings-models/README.md) | DeepSeek clears eligible user overrides while preserving its entry; shared, read-only and environment credentials remain protected. | `provider-reset.ts`, revision conflicts, completed-stage retries and ownership rechecks before credential removal. |
| [Agent presets](../../packages/client/ui-agent-preset/README.md) | Four matching loading cards, refresh retention, retry, responsive whale illustrations, confirmed default switching and compact help dialogs. | `AgentPresetSection`, `section-store`, `PresetIllustration`, dialog focus, reduced motion and the four referenced WebP assets. |
| [Plugin inventory](../../packages/client/ui-settings-plugin-inventory/README.md), [plugin settings](../../packages/client/ui-settings-plugins/README.md) | Both scopes start folded; compact centered headers, animated details, consistent icons, localized descriptions and hidden redundant entry tags. | `InventoryDisclosure`, exact module-description matching, unknown-plugin fallback, single-tab suppression and preserved detail identities. |
| [Conversation](../../packages/client/ui-conversation/README.md) | Suggestions fill a draft without sending it; bounded input history is scoped and respects IME, caret and menu arbitration. | Hero slots, input history parsing, draft restoration, unavailable workspace state and keyboard routing. |
| [Questions](../../packages/client/ui-user-questions/README.md), [primitives](../../packages/client/ui-primitives/README.md) | Compact question areas and reusable pointer/focus highlights without changing other callers' defaults. | Collapse focus, retained answers, `GlideHighlight.bridgeGaps`, listener and animation-frame cleanup. |

AFP is a separate custom plugin. Its source, descriptions and profile choices remain owned by that plugin; do not add AFP-specific global style overrides while resolving inventory conflicts.

<a id="3-resolve-changes-by-behavior"></a>

## 3. Resolve changes by behavior

Review source changes before generated output. API signatures and registration lifecycles come first; appearance adjustments follow the verified behavior.

1. Update every consumer when upstream changes a slot, injected service, store state or public type. Check `settingsSearch`, hero contributions and brand contributions together with their generated slot declarations.
2. Reconcile asynchronous state explicitly: stale reads must not replace a confirmed preset selection; refreshing a populated roster must not return to an empty skeleton; completed reset stages must not be replayed after a later failure.
3. Retain mounted disclosure contents where drafts or answers must survive. Closed regions remain inert; rapid reverse toggles and reduced-motion preferences must remain supported.
4. Regenerate `slot-catalog.ts` and other generated declarations using their owning generators. Do not hand-resolve a generated catalog or add a client service to a Host-only catalog projection.
5. Retain only referenced illustration assets. Build outputs, source maps, screenshots, image-generation drafts and cloned research repositories do not belong in a source commit.
6. Reconcile English and Chinese copy together and regenerate pairing records. Update browser expectations only after reviewing the rendered page, not simply because a test fails.

Installed third-party bundles live in each device's DSH Home. The Web profile used for this review has removed `dshmarket` and `@michengai/dsh-codex-ui` while retaining AFP; pulling or merging Git changes does not install or remove those bundles on another device. Back up the profile manifest, overlay and lockfile before changing that device's installed bundles; never commit credentials or authentication bootstrap URLs.

<a id="4-validate-the-merged-application"></a>

## 4. Validate the merged application

Run the narrowest tests covering the merged changes, then broaden only for shared interfaces or unexplained failures. The maintainer performing the update owns the post-merge checks; the commands below do not assert that a future merge has passed.

```sh
pnpm exec vitest run packages/client/ui-agent-preset packages/client/ui-settings-models packages/client/ui-settings-plugin-inventory packages/client/ui-settings-general packages/client/ui-settings packages/client/ui-conversation
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/agent-preset-authoring.e2e.ts apps/web/tests/agent-preset-selection.e2e.ts apps/web/tests/models-page-layout.e2e.ts apps/web/tests/plugin-inventory-polish.e2e.ts apps/web/tests/settings-navigation.e2e.ts apps/web/tests/settings-chrome.e2e.ts
pnpm run build
pnpm run test:docs
pnpm run doc-sync
pnpm run lint
git diff --check
```

The browser scaffold supplies keyless profiles and the in-page directory picker. For a manual Web launch, use `dsh web` with `apps/web/tests/pin-browse-picker.overlay.yml`; preserve any separate baseline server and its port. Rebuild before interpreting visual results, and compare `.dsh-build/client-build-environment.json` with the source revision.

Verify initial loading, failure/retry and populated refresh; preset selection with delayed writes; provider clearing with shared or read-only credentials; disclosure focus after closing; narrow layouts; light/dark themes and reduced motion. Check that installed plugins match the local profile and that obsolete market UI does not appear after uninstalling its bundle.

Separate pre-existing failures from regressions by comparing the exact failing source and expectation at the recorded baseline. Record the command, failure location and affected owner. Do not loosen style assertions, skip failing tests, or claim all checks pass because a focused subset passes; fix merge regressions before publishing.

<a id="5-update-the-maintenance-record"></a>

## 5. Update the maintenance record

Keep the comparison map current when customization ownership moves, upstream replaces a feature, or a requirement is retired. Remove a row only after the replacement preserves its required behavior and passes the owning tests.

Each update records the old upstream tip, new upstream tip, AutoFlow tip before merging, final commit range, resolved conflicts, deleted customizations, executed checks and remaining failures in its commit or pull-request description. Keep machine-specific screenshots and logs outside Git, and link only portable documentation from committed files.

<a id="further-exploration"></a>

## Further Exploration

- [Development and build workflow](../development.md)
- [Testing ownership and profiles](../testing.md)
- [Bilingual documentation records](../i18n/README.md)
- [Web client registration and rendering](../subsystems/web-client.md)

<a id="dev-note"></a>

## Dev Note

This guide covers AutoFlow customization review. It does not authorize an upstream merge, change profile credentials, or replace persistence-format migration requirements.
