# Better Sidebar source record

Source: [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar), release [v0.28.2](https://github.com/omdsh-dev/DSH-better-sidebar/releases/tag/v0.28.2), MIT license retained in LICENSE. The snapshot imports src, tests, locale and build/type configuration; AutoFlow retains its package icon. Repository instructions, Git metadata, release automation and installer scripts are omitted.

AutoFlow changes the development dependencies to workspace references, disables install-time builds, declares its independent updater, and supplies a bundle patch with local customCss. Imported assertions to unknown are removed for this repository's type policy; loose upstream test fixtures use the test-only shoehorn helper, preference reads use Reflect and inherited seed events explicitly retain the session sequence brand. Client bundles share the application's scoped Cordis module. The updater lives in updater/ as a distinct npm workspace; it is excluded from the sidebar package's published files.

The embedded host half uses `connection.requestRejection` for HTTP and WebSocket admission. Active-worktree discovery preserves a session cwd within the authoritative Git root; repositories with a subdirectory cwd do not fall back to the root. The Git/session selector uses the application's SegmentedControl and unique per-instance IDs; operation filters expose a stable data attribute for the local indicator. New graph and preview text use the application's existing typography tokens.

Runtime updates install official npm artifacts into a profile. They neither synchronize this source snapshot nor apply AutoFlow source changes to the downloaded artifact. Authentication is supplied by the Web application's separately mounted sidebar-access plugin, so this protection survives a sidebar update or updater deactivation.

The local default file-changes presentation is supplied through customCss in the generated bundle patch, outside upstream UI stylesheets. The updater saves the active field into the profile before installation; future updates retain the text, while upstream markup compatibility still needs checking.

The companion bundles the preference parser and catalog from this snapshot. Build both packages together so task-folding preferences and new viewer entries remain available in the local settings page. Its existing code SVG also represents the JSONL viewer.

The lazy-chunk route resolves the package's lib directory from both src and lib Host entrypoints. Source launches serve the same built editor, locale, Mermaid and terminal scripts as packaged launches.

The two-second initial mount fallback retains late preference results. Newer refreshes supersede earlier requests; disposal clears the mount deadline and prevents late results from changing the store. Companion feature options wait for the settings revision to load before opening.
