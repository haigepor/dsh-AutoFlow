---
description: "Scope-grouped read-only plugin inventory tab in Web Plugins settings for the dsh web client: agent-preset compositions first, the global plane behind a disclosure, search across both."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugin-inventory

English | [中文](README.zh.md)

## Summary

The **Plugin list** tab lets Web users inspect plugins without changing their configuration. It lists agent presets followed by the global inventory, both collapsed by default; a search opens both. Cards show localized titles and descriptions when available, identify instances by stable entry id, and expose enablement, source details, runtime status, disabled conditions, and discovery failures; preset-provided global entries name their presets. Search covers both groups and points to matches in other presets. The tab handles loading, empty, no-match, failure, and retry states without exposing transport details, and still shows the global inventory without a preset roster.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open the Plugins section in Settings and select the **Plugin list** tab to inspect the Host's plugin inventory. The tab reads no Remote during plugin activation — selecting it for the first time mounts the component and lazily calls `ctx.remote.pluginInventory.list()` through `api-remotes`.

A failed installation with pending pnpm build permissions offers **Allow these scripts and retry**. The action displays the exact package names and persistent permission scope, then retries the original package spec and activation choice. One click approves the entire displayed group, which can include pending packages from earlier attempts. Closing the page grants no permission.

### Reading a card

Reviewed built-in modules use a concise bilingual inventory dictionary, including separate descriptions for preset entries. Unknown modules retain their package metadata. Each collapsed card uses the plugin's localized title and description when available; a description shows one truncated summary line, with the full text available on hover and in expanded details. Settings shortens literal package-name or module-name fallbacks by removing the npm scope and the `cordis:`, `cordis-plugin-`, or `dsh-`/`dsh-host-`/`dsh-client-` prefix; locale titles remain unchanged. The Host supplies locale and package-field fallbacks in `meta`; the Client selects the current language. Full module specifiers remain available in details and search. Missing descriptions are omitted, and metadata diagnostics appear with the card. This compact naming applies only to Settings, not the sidebar's Plugins page.

Small enablement tags mark disabled, conditional, preset-provided and failed rows; plainly enabled rows carry no tag. Live root-fiber phases use dots: pending is idle, loading and unloading are ongoing, while settled active and failed phases have no dot. Compact headers omit entry-id tags. Distinct entry ids remain in accessible card names, search and expanded details, which also show the full module specifier, full description, source preset, configuration and runtime state, and any disable condition. Preset-provided global entries name their enabling presets and offer a jump to that group. Shipped preset names follow the current locale through the shared presetDisplayText resolver; user-authored presets retain their metadata.

### The preset switcher

The switcher is the same selector-pill-plus-menu control the General settings rows use. It lists every roster preset — the default suffixed as such, broken ones marked — and changes only what the list shows: it writes no settings, and selecting a broken preset shows the discovery-reported reason in place of rows. Choosing the default preset or a session's preset stays where it was: the Agent presets section and the new-session screen.

### Retrying a failed read

A failed read renders the shared error marker inside the tab. Loading shows skeleton cards in the card grid, and current-page synchronization uses the shared ongoing loader. Retrying re-runs the lazy `list()` call without exposing transport details.

The Plugin list also shows synchronization failures on the current page. Its retry reapplies the latest client graph without changing Host enablement or refreshing the page.

-----

The inventory fills its settings column, with a 36px search field, a read-only marker, and functional filters for developer tools, search and context, agents and collaboration, and other infrastructure. Filters combine with text search across both scopes and other presets without writing configuration; clearing them restores the scope disclosures. Recognized module families reuse the shared plugin artwork; file rows use matching filled blue/mint folders, while unknown modules use generic artwork. Card headers remain 64px, with their artwork, copy and trailing controls vertically centered. Longer titles and summaries truncate; details retain complete text and entry identities. Opaque two-column cards use fine borders and soft shadows, becoming one column when their container is narrow. Expanding a card remains tied to its original entry when filters change. Groups and details mount on their first expansion, retain visited content, and transition height and opacity for 250ms; collapsed content is inert. Reduced-motion preferences disable transitions.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tab is a read-only projection of a Host-owned snapshot; it performs no Remote read during plugin activation and takes the snapshot on first selection.

### Registration

The browser plugin registers one localized `settings.plugins.tab` contribution with id `all`; the Plugins section owns the navigation entry and tab chrome. Registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

### Rendering

Row keys are scope-qualified (global:, preset:<id>:<index>), so the same module in both scopes keeps distinct disclosure state. Entry ids remain in details and accessible names, while compact headers omit their tags. Preset-provided marking is derived client-side: a global entry carries it only when disabled globally and enabled by at least one preset; conditional or disabled preset rows do not claim provision.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings section, the remote call, and the Host-side projection.

- [ui-settings-plugins](../ui-settings-plugins/README.md) — the Plugins section this tab registers into.
- [ui-settings](../ui-settings/README.md) — the domain base declaring `settings.plugins.tab`.
- [api-remotes](../../api/remotes/README.md) — the Remote BFF surface behind `pluginInventory.list()`.
- [plugin-inventory](../../host/plugin-inventory/README.md) — the Host-side read-only Loader projection this tab renders.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side inventory projection that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the freshness and reach of the inventory view; they are current package constraints.

- **One snapshot per Settings mount or retry** — the tab does not subscribe to Loader changes or automatically refetch after reconnect; switching tabs preserves the current snapshot, while reopening Settings obtains a new one.
- **Read-only in both planes** — the tab shows global and preset enablement but mutates neither; enable/disable controls that write a custom preset's own composition file are deliberate follow-up work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package owns a read-only Settings contribution.
