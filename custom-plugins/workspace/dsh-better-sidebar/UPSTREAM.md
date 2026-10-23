# Better Sidebar source record

Source: [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar), release [v0.25.0](https://github.com/omdsh-dev/DSH-better-sidebar/releases/tag/v0.25.0), MIT license retained in LICENSE. The snapshot imports src, tests, locale, icon and build/type configuration. Repository instructions, Git metadata, release automation and installer scripts are omitted.

AutoFlow changes the development dependencies to workspace references, disables install-time builds, declares its independent updater, and supplies a minimal bundle patch. Imported assertions to unknown are removed for this repository's type policy; loose upstream test fixtures use the test-only shoehorn helper, preference reads use Reflect and inherited seed events explicitly retain the session sequence brand. Visual styles remain upstream-owned. The updater lives in updater/ as a distinct npm workspace; it is excluded from the sidebar package's published files.

The embedded host half uses `connection.requestRejection` for HTTP and WebSocket admission; it does not depend on the removed `webRuntime` service. Terminal labels include the host command-line accessibility label. The obsolete empty invariant entry is removed. Active-worktree discovery preserves a session cwd within the authoritative Git root; repositories with a subdirectory cwd do not fall back to the root.

Runtime updates install official npm artifacts into a profile. They neither synchronize this source snapshot nor apply AutoFlow source changes to the downloaded artifact. Authentication is supplied by the Web application's separately mounted sidebar-access plugin, so this protection survives a sidebar update or updater deactivation.

The local default file-changes presentation is supplied through customCss in the generated bundle patch, outside upstream UI stylesheets. The updater saves the active field into the profile before installation; future updates retain the text, while upstream markup compatibility still needs checking.
