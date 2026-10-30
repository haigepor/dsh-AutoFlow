# Web UI style reference

English | [中文](web-styling.zh.md)

This reference defines styling ownership and component rules for browser client packages. The current token values live in [`packages/client/ui-theme/src/styles/`](../packages/client/ui-theme/src/styles/); this document does not duplicate that generated-by-source inventory.

## Ownership

[`ui-theme`](../packages/client/ui-theme/README.md) owns the `--dsw-*` static scale, semantic aliases, typography, motion, gradients, shadows, scrollbar styles, and light/dark preference. [`ui-layout`](../packages/client/ui-layout/README.md) applies the resolved theme snapshot to the document. Feature packages consume semantic aliases and do not define another global theme.

Global style sheets belong in `ui-theme/src/styles/`. Component styles live beside their component as CSS Modules. A component may define a local custom property when its value is part of that component's layout or presentation contract; shared colors, typography, elevation, and motion belong to the theme package.

<a id="component-rules"></a>
## Component rules

- Reuse the control before restyling one: the [ui-primitives component catalog](../packages/client/ui-primitives/README.md#component-catalog) is the only channel that crosses feature packages, and a deliberate visual difference belongs in a prop there rather than in a second copy ([reference](../packages/client/ui-primitives/README.md)).
- Use CSS Modules and `clsx`; do not add a component library or Tailwind.
- Use `--dsw-alias-*` semantic tokens in feature components. Do not copy static palette values or write literal colors there.
- Keep theme selectors out of feature component CSS. Light/dark overrides belong to the theme owner.
- Pair font sizes with line heights and use the theme typography variables when an existing role matches.
- Keep source text, terminal output, and diff lines unwrapped when their component contract requires column preservation; use the shared scrollbar styles rather than component-specific scrollbar selectors.
- Put presentation in CSS. Inline React styles may pass component-local custom-property values but must not encode theme branches.
- A relative `url()` in a plugin stylesheet points to a file in the package's `src/client/assets/`, and the build rewrites it to the [package asset](../packages/client/AGENTS.md#dependency-declaration) URL. `data:`, `#fragment`, `/`-rooted, scheme, and empty `url('')` references stay unchanged, a relative file reference with a fragment or query fails the build, and stylesheets from dependencies are not rewritten.
- Put `:hover` selectors under `@media (hover: hover)`, independently of viewport width. Keep selected, expanded, pressed, and keyboard-focus styles outside that condition. Without hover, actions remain visible or accessible through an explicit control; pointer handlers ignore touch when opening hover-only previews. Preserve keyboard focus visibility and reduced-motion behavior.
- Rounded corners inherit the global superellipse smoothing from ui-theme's `corner-shape.css` on supporting engines. Pair `corner-shape: round` with every full-round `border-radius` (`50%`, `100%`, or a pill radius) so circles and capsules keep circular arcs; the ui-theme corner-shape spec enforces the pairing.
- Elevated surfaces (menus, popovers, modals, panels, floating buttons, the composer) set `border: 0` and take `box-shadow: var(--dsw-elevation-panel)`, `var(--dsw-elevation-prominent)`, the menu's `var(--dsw-elevation-menu)`, or the composer's `var(--dsw-elevation-soft)` (larger blur at lower alpha): the 0.5px hairline stroke is the first shadow layer, and `--dsw-elevation-stroke-color` rebinds or suppresses it per surface or state. Never pair a `--dsw-alias-border-*` border with an lv/elevation shadow — the ui-theme elevation spec rejects the pairing; state-colored borders (warn panels) stay real borders.
- Card shells across conversation, settings, plugin management, and side panels share the sidebar guide capsule's restrained frosted material: light cards use a 76% warm-white tint and slightly firmer soft shadow, while dark cards retain the 88% charcoal tint and fine bright rim. Light shared menus use a 68% tint and quieter shadow so blurred page detail remains faintly visible; dark surfaces retain a steadier fill for legibility. The shared material uses `--dsw-specific-menu`, `backdrop-filter: var(--dsw-menu-backdrop-filter)` (`blur(16px) saturate(108%)`), and an elevation token with a theme-aware inner rim and soft shadows. The settings dialog has a 90–92% fill and 22px blur; warm off-white and charcoal canvases, restrained iris accents, and neutral shadows carry the built-in light and dark palettes. Nested detail cards use a translucent tint without another blur, so the outer shell stays the single glass layer. Keep code and data canvases, message bubbles, and controls on their semantic fills for legibility and interaction contrast. Unsupported blur and `prefers-reduced-transparency` use opaque theme fills; macOS keeps its near-opaque fill over the transparent desktop window. A surface containing fixed-position overlays paints the material on an isolated background pseudo-element so the filter does not change those overlays' containing block. Shared dropdowns use the compact `Menu` geometry; feature-owned menu content may vary without recreating the material or scrollbar implementation ([decision](../.agents/notes/implemented/feature/2026-09-17-compact-translucent-menu-surfaces.md)).
- Dropdown, context, submenu, and selection menus use `Menu` or `MenuSurface`, which owns `--dsw-menu-surface-fill`, `--dsw-menu-backdrop-filter`, and the menu-specific hairline and elevation; feature CSS does not redefine these tokens. Standalone task and lineage menus use `--dsw-menu-standalone-fill` and the same elevation, while `TaskMenu` and `ClockPicker` remain schedule-owned exceptions. On macOS, `MenuSurface` mounts a backing within the menu bounds so Chromium can blur page content over native vibrancy; standalone menus use a near-opaque fill. Unsupported blur and reduced transparency use opaque menu fills. Other overlays keep their `--dsw-specific-menu` fill. Modal masks use the subtle theme-owned `--dsw-mask-blur` while Desktop-owned overlays leave the parent page unfiltered.
- Flat borders and separators that use a neutral `--dsw-alias-border-*` token draw at `0.5px` — buttons, inputs, cards, row dividers, and separators drawn as filled boxes (menu separators, the conversation header seam, markdown `hr`, vertical rails) share the hairline weight, which Chromium paints as one device pixel. Dashed affordances and state-colored borders keep 1px; spinner ring tracks keep their width through the spec's explicit allowlist. The ui-theme elevation spec rejects wider neutral solid borders.
- Clickable artifact links (markdown anchors, prose file mentions, web source and fetch links, produced-file chips, workflow member links) color through `--dsw-alias-link` at `font-weight: 500`, with no underline at rest and a dotted 3px-offset underline on hover/focus. Compact Thinking Markdown keeps tertiary text color and a resting dotted underline ([compact presentation](../packages/client/ui-primitives/README.md#rendering-agent-output)). Text-leading anchors also lead with the ui-primitives `LinkIconMedium` category glyph riding `currentColor`, which for a well-known external host is that site's own mark instead of the globe; workflow member links and image-only anchors carry no glyph, and tool-row file links keep their grey dotted affordance.

<a id="input-capabilities"></a>
## Input capabilities

`pointer` and `hover` describe the primary pointing device chosen by the browser; `any-hover` considers every available pointing device. None detects a physical keyboard.

- Use `(pointer: coarse)` for presentation that depends on pointing accuracy, such as touch-sized controls and text fields.
- Keep CSS hover effects under `(hover: hover)` so a touch-first layout remains usable without hover.
- JavaScript hover previews use `(any-hover: hover)` when accepting mouse entry and ignore touch entry. A secondary mouse can therefore open a preview even when the touchscreen remains the primary pointer. Enabling all CSS hover styles through `any-hover` would also enable them for touch-generated `:hover` states.

On a mixed-input device, a mouse preview can appear while the primary-pointer CSS hover style stays inactive. Keyboard focus and shortcut hints follow actual keyboard interaction independently of these capability queries; [Menu and input modality](../packages/client/ui-primitives/README.md#input-modality) define the shared behavior.

<a id="corner-radii-and-settings-cards"></a>
## Corner radii and settings cards

The [DSH unified corner-radius standard](ui-radius.md) defines the radius scale, component size mapping, circle and capsule exceptions, nested hover geometry, and settings-card fills and strokes.

## Changing the system

Add or change a shared token in the owning `ui-theme` sheet, then consume its semantic alias from feature packages. Update the owning package reference when a public styling contract changes. Visual behavior follows the [testing policy](testing.md); the [archived styling-system Agent Note](../.agents/notes/archived/process/2026-07-19-web-styling-system.md) records framework rationale.
