---
description: "Profile-owned updates of Better Sidebar from upstream GitHub releases and npm artifacts."
kind: "package-bundle"
---

# dsh-plugin-better-sidebar-updater

English | [中文](README.zh.md)

## Summary

This independent package checks the official Better Sidebar GitHub release and downloads the exact matching npm package. It reuses the application plugin manager for archive inspection, installation locks, failure recovery and restart. Checks do not install updates automatically. It remains usable when the sidebar is disabled.

## Use this package

Run `pnpm --filter dsh-plugin-better-sidebar-updater build`. New Web and Desktop profiles enable this shipped updater by default; existing profiles retain their activation choices and can enable it on the Plugins page. Open the sidebar or updater detail page, choose **Check for updates**, then **Install update**. Save your work before **Restart to apply**; a carrier without restart support requires closing and reopening the application.

The updater uses no credentials. The upstream source is omdsh-dev/DSH-better-sidebar; npm artifacts come only from registry.npmjs.org/dsh-better-sidebar. The GitHub release version must match the registry package and expected tarball URL. Complete bytes are checked with npm SHA-512 integrity; this verifies registry artifact integrity, not equivalence to a Git commit. Missing npm publication and incompatible DSH or Node versions prevent installation.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| checkIntervalMs | 3600000 | Background check interval; zero disables background checks. |
| pollIntervalMs | 1000 | Visible in-progress status polling interval. |
| timeoutMs | 30000 | Timeout of one upstream response. |
| jsonBytes | 1048576 | Maximum metadata response bytes. |
| archiveBytes | 67108864 | Maximum compressed package bytes. |

Configure these fields on the updater row. The shared plugin manager retains its expanded-archive limits. Installation replaces only the current profile's sidebar dependency, retaining bundle selection and settings; source files, updater code, application theme and layout are not overwritten.

Before installation, the sidebar's raw configuration, including customCss, is explicitly saved into its profile override even when it matches inherited defaults. Disabled component rows retain unchanged configuration without schema-free edits; deselected bundles are composed offline and retained without activation. An unavailable or ambiguous configuration owner aborts installation. This retains settings and local styles after the official package replaces the local bundle defaults.

The Plugins list combines Better Sidebar and this updater into one Better Sidebar entry. Its compact detail page keeps updates visible by default, shows both modules' independent activation switches and folds technical package metadata. The update section shares AFP's rounded card, padding and separator rules, with manual-install guidance and release notes in the lower row. It has no automatic-install control and works independently of AFP activation. Official sidebar npm updates replace neither this updater nor the combined page styles; their association comes from the installation's manifest. The shared manager retains active and installed versions until restart, including when this updater is deactivated and reactivated.

Checks and installations use AFP's shared loading ring and indeterminate progress track. Folding keeps only the ring; completion removes the feedback. Reduced-motion preferences stop the animations, and no total completion percentage is inferred.

Its Client also supplies sliding file-change selection indicators when the sidebar's customCss opts in. Measurements follow the existing buttons without changing click or keyboard handlers. Observers handle selection, container and button size changes; deactivation removes the measurements and restores ordinary selection styling. These local files remain outside official sidebar npm replacements.

The companion Client supplies the local sidebar settings page through the existing settings.section priority mechanism. It reuses the official entry's injected store and live descriptor registry; unloading the companion restores the official renderer. Content and preview rows use shared Switch/Button controls, distinguish the hidden diff preview, and keep feature settings accessible while disabled. CSS edits are applied explicitly; drafts survive settings-page navigation within this Client lifetime but are not persisted across a full reload. Writes are serialized against acknowledged revisions; failures retain CSS drafts and refresh settings before later writes. The page and compiled support code live in the companion artifact, outside official sidebar npm replacement. Compatibility depends on the upstream settings injection and descriptor APIs.

The nine builtin settings icons are editable SVG assets in `assets/icons`, with bright accent colors and matching gray icon containers; the Code SVG itself has no tinted fill; external extensions retain their own icons. Native sidebar title icons align centrally with the text through the title slot selector. Custom CSS uses CodeMirror with CSS highlighting, line numbers, undo/redo and live light/dark syntax themes; edits still require Apply. These presentation changes ship in this companion, not the upstream sidebar package.

Feature settings and extension catalogs use local dialog chrome with a fixed header/footer and one scrollable body. Setting rows use separators; catalog titles have rounded accent bars, with descriptions and wrapped command blocks aligned below the title text. The shared Modal retains keyboard focus and Escape handling, while companion-owned forms preserve search, clipboard and setting behavior. Inputs, switches, buttons and dropdowns use shared application primitives with semantic typography, color and radius tokens. Portaled menus own scoped multiline option styles and standard icon slots; the built-in editor adapter retains its openWith data format, while external custom renderers remain extension-owned. CSS Modules keep readable file prefixes to avoid collisions with independently bundled plugins. HTML sandbox warnings remain visible.

## Model Experience

No prompt, tool schema or model-visible input is contributed. Background checks make network requests but do not call a model.

## Known Limitations and Deferred Work

Official packages replace sidebar implementation changes instead of merging them. Automatic installation and downgrades are not provided. A failed package operation restores profile configuration through the shared manager; previously allowed dependency-script effects are outside this recovery. Restart support depends on the application carrier.

## Dev Note

Run `pnpm --filter dsh-plugin-better-sidebar-updater test` for source validation regressions. The parent package owns the imported sidebar source and license.
