# AutoFlow upstream integration record

English | [中文](autoflow-upstream-integration.zh.md)

This record identifies the custom work in this AutoFlow release and defines how to compare it with a later DeepSeek Harness release. The [path manifest](autoflow-local-change-manifest.json) lists the files changed between the previous pinned official commit and `autoflow-v0.2.0`, plus every path changed in the working tree before this release commit. The new version tag owns the released file contents.

## Snapshot and branches

| Item | Pinned value | Purpose |
| --- | --- | --- |
| Snapshot date | 2026-09-28 | The inventory applies to this checkout at this date. |
| Custom branch `main` | Tag `autoflow-v0.2.0` | AutoFlow changes and the previous official integration. |
| Previous custom version | Tag `autoflow-v0.3.0` | Pins the Settings, Models, sidebar, and menu visual baseline. |
| Current integration version | Tag `autoflow-v0.4.0` | Pins the official `dsh-v0.2.0-rc.1` integration. |
| Official branch `deepseek-harness` | Second parent of `autoflow-v0.2.0` | The exact official source integrated by that tag. |
| Official remote | `upstream` → `deepseek-ai/deepseek-harness` | Read official changes before integrating them. |
| Custom remote | `origin` → `haigepor/dsh-AutoFlow` | Holds `main` and the official mirror branch. |

The two branches are the comparison anchors. The second parent of the `autoflow-v0.2.0` merge commit pins the previous official baseline; `autoflow-v0.3.0` pins the custom visual baseline; `autoflow-v0.4.0` pins this official integration. Advance `deepseek-harness` to the official commit first; select and integrate changes into `main` only after reviewing the resulting diff. Retain these tags so the next reviewer can distinguish official updates from local styling.

## Official update check

On 2026-09-28, a direct read of `refs/heads/master` on the official `upstream` remote matched local `upstream/master`, `deepseek-harness`, and the second parent of `autoflow-v0.2.0`. There were no new commits on official `master` relative to the mirror branch. The matching commit was dated 2026-09-27 22:30:17 (+08:00) and merged [PR #5282](https://github.com/deepseek-ai/deepseek-harness/pull/5282). This check did not advance either branch or integrate code into `main`. Read the remote again before the next integration.

## `dsh-v0.2.0-rc.1` integration decisions

On 2026-09-29, the official mirror branch `deepseek-harness` advanced from `21638c56315ae6a2b552d6091945d3144c9af32e` to `4878cdabd87d4041bdaff61d04c966883b9fd07a`, the commit shared by the official `dsh-v0.2.0-rc.1` tag and `master`, before merging into `main`. The official range contains 106 commits. The table names the areas that intersect local UI work; other official features and fixes remain in the merge.

| Area | Official change | Decision |
| --- | --- | --- |
| Conversation and plugins | Process animation and spacing, retry summaries, plugin installation guidance, and the Session Log upload preference. | Integrate behavior and required controls; retain the local sidebar, plugin-card spacing, and Settings page layout. |
| Desktop overlays | Windows caption and macOS top clearance, including modal and menu placement in fullscreen. | Adopt the new overlay tokens and mask placement; retain the local menu material and full-window Settings page rather than restoring the older official dialog. |
| Theme colors | New tokens for document selection, switch thumbs, tooltip keys, and activity text shimmer. | Keep the local warm-white and charcoal palettes with a violet accent. Selection uses the violet link color at 36% opacity in light mode and 34% in dark mode; the dark switch thumb uses warm gray. |
| Models and onboarding | The first-run notice becomes a preview notice and repeats after an older version was accepted. | Integrate the updated copy and behavior; retain the provider rail, independently scrolling detail pane, and model table. |

“Retain local” applies to existing layout, colors, and materials. CSS, copy, configuration, and callers required for new official features are included. Future integrations still compare individual visual changes under the rules below.

## What this snapshot contains

| Area | Current custom work | Decision for the next integration |
| --- | --- | --- |
| Committed AutoFlow baseline | The Atelier light/dark palette, translucent menus and cards, desktop welcome styling, real-API E2E CI policy, and removal of Dependabot branch creation are present between the pinned official commit and `main`. | Keep intentional product and CI behavior; compare upstream component changes with the custom theme before choosing styles. |
| Theme and shared menu material | Working-tree edits span `ui-theme`, `ui-primitives`, model/input menus, job and schedule popovers, and several feature-owned CSS modules. | Review each visual change in light and dark themes. Merge feature-required CSS with its feature, then align colors, opacity, blur, borders, and focus states with the accepted theme. |
| Sidebar and workspace | Working-tree edits cover sidebar expansion, active and hover highlights, workspace rows, the main region, and conversation spacing. | Check layout geometry and interaction together, including collapsed navigation, narrow windows, and window drag regions. |
| Full-window Settings | This release replaces the modal route with a Settings page and navigation through `ui-layout`, `ui-settings`, and `ui-settings-general`. | Carry the navigation feature as a unit with its layout state, slots, docs, and tests; adapt it to any upstream navigation changes before reviewing its styling. |
| Models Settings | This release introduces the provider rail, a wide independently scrolling detail panel, model-table presentation and sorting, shared pickers, compact fields, and optional help panels. | Treat the editor and selection behavior as a feature; adapt official changes while retaining the local layout and focused checks. |
| Plugins and other settings | Working-tree edits cover plugin settings presentation and plugin-manager card spacing. | Keep registered settings content and toggle behavior; compare local card styling against upstream. |
| Documentation and checks | The path manifest records package README pairs, translation sidecars, style documentation, snapshots, and tests changed with the work above. | Update documentation and focused verification with the final chosen behavior, not with an intermediate screenshot or an unresolved implementation. |

The manifest records paths and Git status rather than trying to infer intent from filenames. Review the actual diff for each path before classifying a hunk; a component file can contain both functional and visual changes.

## Local style baseline

| Area | Local visual intent to retain | Principal files |
| --- | --- | --- |
| Theme and notices | Warm white and charcoal theme tokens; theme-specific menu opacity, outlines, restrained shadows, and reduced-transparency fallbacks; matching text and accent colors in notices. | `ui-theme`, `ui-primitives` |
| Menus and popovers | The shared menu, model picker, command, job, schedule, account, and input-trigger menus use coordinated frosted material while keeping their own placement and interaction. | `ui-primitives`, feature-owned menu CSS |
| Main sidebar and workspace | Top spacing, no right divider, compact navigation rows, hover and active highlights, centered collapsed icons, and separate sidebar and main-region colors in both themes. | `ui-sidebar`, `ui-workspace`, `ui-layout`, `ui-conversation` |
| Settings page | Full-window left navigation and right content; return and collapse controls, navigation highlight, content width and scrolling, and narrow-window layout. | `ui-settings-general`, `ui-settings`, `ui-layout` |
| Models Settings | A stable provider rail and independently scrolling details; tabular model catalog, row numbers and drag handles, compact two-column fields, optional help, refined checkboxes, and an illustrated heading. | `ui-settings-models` |
| Plugins | Vertical spacing between Plugin Manager cards and the heading, group, tab, and card spacing on the Plugins Settings page. | `ui-plugin-manager`, `ui-settings-plugins` |

This table identifies the local visual intent; the [path manifest](autoflow-local-change-manifest.json) lists exact files. The graphical Appearance choices remain a [proposal](autoflow-appearance-proposal.md), not delivered styling.

## Integration decisions

1. **Functional additions:** keep the AutoFlow capability by default, including its state, persistence, locale copy, accessibility, and tests. If upstream changes the same API or flow, adapt the feature to the new official implementation rather than overwriting either side wholesale.
2. **Visual changes:** retain this local style baseline by default. Compare official and AutoFlow results in both themes. Before replacing local colors, spacing, geometry, motion, or layout with upstream styling, identify the affected components, differences, and consequences, and obtain explicit user approval. Without approval, do not overwrite the local styling.
3. **Feature-associated styles:** merge new styles required by an upstream feature and align them with the local theme. If that adaptation would replace existing styling, obtain approval under the previous rule first. Adding styles needed only by the new feature does not replace the old visual treatment.
4. **Mixed files:** review by hunk. Functional logic can adapt to upstream changes, but local visuals in the same TSX/CSS file still require approval before replacement. Do not apply a whole-file or branch-wide “ours” or “theirs” resolution.
5. **Generated and support files:** regenerate or update the affected snapshots, translation records, lockfile, and docs after the chosen code is in place. Do not treat an old snapshot as product behavior authority.

For each area, record the old and new official commit, affected paths, chosen behavior, visual decision, focused checks, and unresolved conflicts in the next integration entry. A visual decision needs a screenshot or a reproducible browser state for both themes; an interaction decision needs the related state transition and failure path.

## Next official update

1. Start from the latest integration tag `autoflow-v0.4.0` and save any later custom work as a reviewable Git state before integrating. The path manifest locates older changes but does not recover their contents.
2. Advance `deepseek-harness` to the new official commit and write down the previous and new official IDs. Keep the official branch free of AutoFlow edits.
3. Compare that official range by subsystem, then compare the same files against `main`, the [path manifest](autoflow-local-change-manifest.json), and the local style baseline. Start with stateful features and public interfaces, then present any proposed visual replacement for user approval.
4. Integrate functional additions into `main` with their consumers and docs. Add styles required by those features; keep existing local styling unless the user has approved its specific replacement.
5. Run focused type, build, interaction, bilingual-doc, and browser checks for the changed areas. Record failures as unresolved; do not label a slice integrated while a known regression remains.
6. Update this record and the manifest after the integration, and create a Chinese version tag entry for a major release.

## Appearance follow-up

The current General section owns the light/dark/system control and conversation font size. The [Appearance page proposal](autoflow-appearance-proposal.md) and its [SVG preview](assets/autoflow-appearance-concept.svg) show how these can move to a dedicated section. Color presets, font family, radius, density, sidebar style, layout, content width, and direction in that proposal are design candidates; the current theme settings schema does not persist them. Keep this distinction visible during a future upstream comparison.

## Limitations

The manifest keeps the paths and Git statuses before `autoflow-v0.3.0` for locating those changes; `autoflow-v0.3.0` and `autoflow-v0.4.0` store the complete code at each release. The official update finding applies only to the check date and the `master` branch, not to later states or other branches and tags. The Appearance page remains a proposal.
