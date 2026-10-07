---
description: "Appearance theme settings for the dsh web client: color mode, accent, interface font, corner scale, content size, and pre-plugin bootstrap."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-theme

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-theme` owns the Appearance theme Settings section: system/light/dark modes, official and current-project palettes, five interface fonts, five corner scales, menu animation speed, and conversation content size from 12 to 17 px. A loopback client persists these choices in the `ui-theme` settings namespace, which the local provider stores in `$DSH_HOME/cordis.patch.yml` by default. The plugin resolves `system` through `prefers-color-scheme` and publishes immutable `ThemeSnapshot`s; ui-layout applies each snapshot to the document. The package ships the `--dsw-*` token stylesheets and injects synchronous bootstrap values before the shell loads. Third-party themes can register alias-token overrides through `ctx.theme`.

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

In Settings, this section uses the shared 26px page title, 36px line height, weight 600, and 24px title spacing. Page titles omit decorative icons and introductions; setting-level help and actions remain available. The shell supplies equal horizontal insets and a 24px top inset.

Users choose their appearance from the dedicated Appearance theme section in the Settings sidebar. Feature plugins consume the current snapshot through `ctx.theme` and read the `--dsw-*` tokens in CSS; they do not manage theme state themselves.

The page fills the Settings shell’s content width and contributes its five preference-group headings to the cross-page search index. Selecting a search result focuses the corresponding heading without mounting other settings pages.

### Appearance choices

The Appearance page uses the same single-column setting rows as General: labels and descriptions on the left, 36px selection controls on the right, 16px vertical padding, and fine separators. Three equal-width mode cards switch directly between system, light, and dark, with a thin selected border and pressed state. Two compact palette cards show theme-owned SVG interface previews and the names Blue Gray and Iris; they select the official or current-project palette respectively. Preview colors remain independent of the active palette and follow light/dark mode. Three shared menus select the interface font, corner scale, and menu-glide duration (80, 140, 220, 300, or 400 ms). The font trigger and each menu label use the corresponding locally bundled font; the system-default sample uses the device stack independently of the current interface font. Controls align to the right edge and move below the text on narrow screens. Menus use tokenized surfaces, selection checks, portal placement, and keyboard navigation. The five current fonts are system default, Source Sans 3, IBM Plex Serif, JetBrains Mono, and IBM Plex Sans Condensed. The official palette is copied from the `dsh-v0.2.0-rc.1` release tag; its conversation and full-window Settings content use the official base fill beside the official sidebar fill. The current-project palette keeps the warm-gray and iris-purple treatment. Code and brand text retain their own font stacks. Accepted service writes pass through the Host settings API in gesture order with namespace revisions, and a rejected latest write reloads durable values. Non-loopback pages keep choices process-local.

Existing user layers without `themeSet` retain the current-project palette and their old accent selection. A new installation and Reset appearance select the official palette, system mode, system font, the standard corner scale, and 220 ms motion. Legacy Inter and Noto Sans SC values remain readable until a user picks a new font.

### Registering a theme

A composition can register a third-party theme id with alias-token overrides through `ctx.theme`; the override layer folds into the active snapshot's tokens in registration order. Removing one never overwrites the last durable built-in preference. Third-party theme ids remain an in-process extension and do not cross the built-in settings schema.

### Pre-plugin palette

When the host composition includes an HTTP server, the host half embeds the registered `ui-theme` settings, or schema defaults, into each index response. Head CSS selects the document canvas color scheme before any script runs, including a `prefers-color-scheme` query for the `system` preference. A body script then sets `body[data-ds-dark-theme]`, the accent/font/corner attributes, and `--dsh-content-font-size` before the loading page and application scripts, so the first paint uses the selected values.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Shared menus use `--dsw-menu-surface-fill`, blur, and menu-specific elevation through `MenuSurface`; standalone menus use `--dsw-menu-standalone-fill` and the same elevation. Platform code keeps standalone menus nearly opaque on macOS and both menu fills opaque when transparency is reduced or blur is unavailable. Other overlays retain `--dsw-specific-menu`. The enforced source rules are defined in the [styling reference](../../../docs/web-styling.md#component-rules). Modal masks retain their dark translucent fill with the subtle theme-owned background blur.

The Conversation surface uses `--dsw-specific-conversation-fill`: white beside the warm light sidebar (`#F1F0ED`), or `#20201E` beside the dark sidebar (`#161615`). The token stays opaque so text and the composer remain readable.

System toast colors are paired per theme: `--dsw-alias-toast-bg` and `--dsw-alias-toast-label` set the surface and message, while `--dsw-alias-toast-warn`, `--dsw-alias-toast-success`, and `--dsw-alias-toast-action` color its icon and inline action. The official palette uses a white surface with dark text in light mode and a charcoal surface with light text in dark mode; each mode defines its own action, success, and warning colors.

<details>
<summary>Implementation internals — click to expand</summary>

The service owns appearance state and publishes snapshots. The ui-layout presenter applies those snapshots, and the token sheets own color, font, corner, and conversation text scales.

### Stylesheets

`base.css` owns the shared radius scale and settings-card material aliases. The material aliases resolve on `body`, alongside the active palette. Follow [Web styling](../../../docs/web-styling.md#corner-radii-and-settings-cards) when choosing component radii.

`src/styles/` holds eight sheets imported in order by ui-theme's dynamic client entry: `base.css`, `corner-shape.css`, `design-platform.css`, `focus.css`, `onboarding.css`, `scrollbar.css`, `gradient-shadow-text.css`, and `shiki.css`. The client bundle compiles and injects them as plugin-owned global styles, so unload and HMR remove them with ui-theme. `scrollbar.css` consumes the `--dsw-alias-scrollbar-*` tokens and must follow `design-platform.css`, which declares them. Status marks use their own semantic state tokens. `--dsw-alias-bg-document-selection` uses the local violet link color at 36% opacity in light mode and 34% in dark mode for selections over original document colors. `design-platform.css` also owns the code-diff fill aliases and their static alpha palette entries, plus the `--dsw-alias-file-diff-*` code, gutter, and marker palette for file comparisons; `shiki.css` owns syntax colors.

[`focus.css`](src/styles/focus.css) provides a `:focus-visible` fallback that names the ring colour through `var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))` and the standard width through `--dsw-focus-ring-width`, never the outline style — so a control that disables its outline stays paintless, and one that declares no ring keeps the standard geometry instead of Chromium's `auto 1px`. The theme resolves this blue to `#4176E6` in light mode and `#7AAAFF` in dark mode. Component outlines and focus-ring shadows use the same colour expression, including rings on descendants and pseudo-elements. `--dsw-focus-ring-width` (2px) is the standard width; dense tables and toolbars may keep 1px, and offsets remain component-owned.

In pointer modality, `html[data-input-modality='pointer'] body :focus-visible:not(:read-write)` makes the ring colour transparent. Descendants and pseudo-elements inherit that value; the rule does not clear `box-shadow`, so elevation and selected-state borders remain independent of ring visibility. Editable text controls matching `:read-write` retain their own focus feedback on click. [Input modality](../ui-primitives/README.md#input-modality) determines when keyboard focus styling resumes; it does not move DOM focus.

Menu icons use `--dsw-alias-menu-icon`: neutral-bluish 800 in light mode and `label-primary-dimmed` in dark mode.

`base.css` suppresses only the outline of focused elements marked `data-dsh-automatic-focus` by the [primitive focus helper](../ui-primitives/README.md); ordinary keyboard focus styling, borders, shadows, and error states remain intact.

System toasts use `--dsw-alias-toast-bg` and `--dsw-alias-toast-label` for a shared background and text color across callers. Document previews pair `--dsw-alias-bg-document-preview` with `--dsw-alias-label-document-preview` so the backdrop and status text follow the same theme. Tooltip keycaps use `--dsw-alias-tooltip-key-bg`, a lighter fill derived from the tooltip background in each palette. Switches use `--dsw-alias-switch-thumb`, `--dsw-alias-switch-active-track`, `--dsw-alias-switch-active-thumb`, `--dsw-alias-switch-loading-track`, `--dsw-alias-switch-loading-thumb`, and `--dsw-alias-switch-loading-indicator`: an off thumb is warm gray in dark mode, an active track follows the accent at a lower dark-mode luminance, and a pending write uses a neutral track with a contrast-matched thumb and ring in each theme.

`--dsw-alias-label-shimmer` supplies an overlay for the shared text shimmer: black at 30% alpha in the light palette and white at 45% alpha in the dark palette. `--dsw-alias-label-deep-diving` and `--dsw-alias-label-deep-diving-shimmer` supply the local violet activity label and sweep; the dark palette uses a lighter, less saturated label with a brighter violet sweep.

`brand-font.css` exports the local Montserrat Light, Regular and Medium faces (normal style, weights 300, 400 and 500), with `montserrat-light.woff2`, `montserrat-regular.woff2`, `montserrat-medium.woff2` and its SIL Open Font License in `lib/styles/`. Desktop bundles the same stylesheet, font and license for offline welcome brand text; the interface font choice does not alter brand text.

`appearance-font.css` loads the selected local font with CJK system fallbacks. Source Sans 3, IBM Plex Serif, JetBrains Mono, and IBM Plex Sans Condensed are downloaded from Google Fonts commit `23e54b51ddffbc7713c583748e3bd86f62b1fa4a`; their OFL files ship beside the assets in `lib/styles/`. Inter and Noto Sans SC stay bundled only to read legacy saved choices. The system option avoids web-font downloads.

`corner-shape.css` smooths every rounded corner: inside `@supports (corner-shape: superellipse(1.5))` it defines `--dsw-corner-shape` and applies it to all elements and their `::before`/`::after` through the universal selector, so engines without `corner-shape` keep circular corners. Full-round shapes — `border-radius: 50%` circles and pill radii — pair `corner-shape: round` with their radius in the owning component sheet because a superellipse deforms them; the corner-shape stylesheet spec enforces that pairing across every package stylesheet.

`gradient-shadow-text.css` derives `--dsh-content-font-delta` from `--dsh-content-font-size` and shifts the Markdown heading and base-text ladder by that increment. It also derives the secondary tier `--dsh-content-font-size-secondary` (setting −1 at ≤14, setting −2 above; 13px at the default) with its own `--dsh-content-font-delta-secondary` for the table variants and the flow rows one step under the body. Dense small and code variants stay fixed. Outside the ladder, the user bubble and composer draft read the body pair directly, and flow-row titles and summaries read the secondary pair. The sheet also owns the shadow scale (`--dsw-shadow-lv*`), the frosted menu/card filter (`blur(16px) saturate(108%)`), and the elevation tokens: each tier combines a rebindable 0.5px hairline, a theme-aware inset rim, and soft theme-specific shadows. Menus use a dedicated light/dark stroke and soft elevation; other elevated card shells that paint `--dsw-specific-menu` apply `backdrop-filter: var(--dsw-menu-backdrop-filter)`. Nested content can use translucent tint without repeating the blur. The settings dialog uses its own 90–92% material and 22px blur; the built-in light and dark palettes pair warm neutral surfaces with restrained iris accents. Unsupported blur and reduced-transparency preferences use opaque theme fills ([decision](../../../.agents/notes/implemented/feature/2026-09-17-compact-translucent-menu-surfaces.md)).

### Scrollbar rebinding

`scrollbar.css` binds `--dsh-scrollbar-thumb` and `--dsh-scrollbar-thumb-hover` on `body` to the l1 base-surface tokens; an elevated surface (menu, popover, dialog) rebinds them to the l2 tokens on its own container, and the pair's other legal target is `transparent` (ui-sidebar rebinds its column that way while the pointer is elsewhere). WebKit-based browsers use a 5px default `--dsh-scrollbar-width` and also read `--dsh-scrollbar-thumb-border` and `--dsh-scrollbar-track-margin`; a scroll surface may rebind them to keep a wide draggable rail around a narrower visible thumb or to inset the track from rounded ends. The two rendering paths are mutually exclusive by construction: Firefox takes the standard thin scrollbar inside `@supports not selector(::-webkit-scrollbar)`, and WebKit-based engines take the pseudo-elements, so geometry and hover customization apply only through the pseudo-element path.

### Preference persistence

The service provides itself immediately with the schema defaults on a loopback browser, then loads the `ui-theme` namespace and writes each accepted appearance change through the Host settings API. Pushed settings changes and reconnects refetch the namespace. Non-loopback pages do not create that Host-backed scope. The persistence boundary is owned by the [Host-backed preferences note](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the layout presenter, the token consumers, and the styling rules.

- [ui-layout](../ui-layout/README.md) — the presenter that applies the resolved theme snapshot.
- [ui-sidebar](../ui-sidebar/README.md) — a consumer of the scrollbar rebinding contract.
- [ui-conversation](../ui-conversation/README.md) — a consumer of `--dsh-scrollbar-width` for the composer seat.
- [Web styling](../../../docs/web-styling.md) — the authoritative styling rules for web client components.
- [Host-backed preferences](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.md) — the persistence boundary decision.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the theme extension surface and the color authority; they are current package constraints.

- **Third-party themes are an extension point, not a product** — registering one means overriding same-named alias variables; no validation exists that an override set is complete.
- **The token sheets are the sole color authority** — values absent from the design system are deliberately not appended; the nearest semantic token wins, and design-owner-approved additions enter as a static step plus a semantic alias in the same change.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The settings scope validates and publishes the durable theme section, while the registry emits `theme/change` synchronously with its own mutations. Store/registry agreement is covered directly by this package's Host, scope, and service behavior specs.
