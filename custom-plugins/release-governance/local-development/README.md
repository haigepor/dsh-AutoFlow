# Local plugin and Desktop testing

English | [中文](README.zh.md)

## Summary

Use a local plugin archive to test changes in an installed Desktop without waiting for GitHub. Use Desktop source preview when changing the application or its Host. Run all commands from the repository root with the installed workspace dependencies. The [root scripts](../../../package.json) define the command names; [publication policy](../README.md) governs public versions and immutable assets.

## Choose a command

Each supported plugin has a formal publication command and a separate local packaging command:

| Plugin | Formal GitHub release | Local archive |
|---|---|---|
| Visual Curator | `pnpm run dsh-plugin-visual-curator` | `pnpm run dsh-plugin-visual-curator:local` |
| AFP | `pnpm run dsh-plugin-afp` | `pnpm run dsh-plugin-afp:local` |
| Codex Subscription | `pnpm run dsh-plugin-codex-subscription` | `pnpm run dsh-plugin-codex-subscription:local` |
| Style Prompt | `pnpm run dsh-plugin-style-prompt` | `pnpm run dsh-plugin-style-prompt:local` |
| Boot Animation | `pnpm run dsh-boot-animation` | `pnpm run dsh-boot-animation:local` |

Local packaging permits uncommitted changes by default. It builds the selected plugin into staging, checks its declared entries and dependencies, calculates SHA256, and prints progress and an absolute `.tgz` path. It does not contact GitHub, run the native platform matrix, install a plugin, restart Desktop or change the source manifest. Generated workspace files remain untouched in quick mode. Add `--full-checks` to run the package's existing `check` and `test` commands before packaging; those commands retain their existing build side effects.

```sh
pnpm run dsh-plugin-visual-curator:local
pnpm run dsh-plugin-visual-curator:local --out .artifacts/manual-plugin-tests
pnpm run dsh-plugin-visual-curator:local --full-checks
pnpm run dsh-plugin-visual-curator --help
```

The local output contains a uniquely versioned archive, `SHA256SUMS` and `local-build.json`. The receipt records the source commit, uncommitted-change flag, source version and checks actually run. It is not GitHub update metadata. The default directory is `.artifacts/plugins/<package>/local/<local-version>/`. `--out` replaces the output root and retains the unique version subdirectory. Do not edit source files during a build or overwrite an existing archive. Keep archives while a test profile references their absolute paths.

## Test in an installed Desktop

Use the existing plugin installation form; a dedicated local-file picker is not required for this path.

1. Edit the plugin, run its `:local` command and copy the printed absolute `.tgz` path.
2. In the plugin's version-update panel, turn off automatic download and installation for the local test. Manual update checks remain available.
3. Open plugin installation, paste the absolute path into **Package name or address**, inspect the installation result and install. Paste the path without shell quotes. Enter the archive path rather than the installed package name; a package name alone is treated as an already installed package.
4. Restart when requested. For a replacement without HMR, the current process continues to use its loaded version until restart. Confirm the installed `-local` version and test the affected feature after restart.
5. Repeat packaging and replacement for the next edit. Keep the same package name and feature IDs; do not uninstall as part of this loop.

The installer accepts absolute `.tgz` and `.tar.gz` paths and `file:` archive specifications. Its tarball replacement behavior is owned by the [plugin manager](../../../packages/boot/plugin-manager/README.md) and [replacement regressions](../../../packages/boot/plugin-manager/tests/package-reload.spec.ts). Installing an archive through this form is the current manual path; it does not provide the dedicated import preview described in Dev Note. Use an isolated development profile when testing persistence, compatibility or failure recovery.

## Local versions and official updates

Local packages use `<source-version>-local.<UTC YYYYMMDDHHmmss>.<milliseconds>`, for example `0.2.13-local.20261105103000.123`. Only the staged manifest receives this version. The package retains its declared `dsh.bundle.update`, repository, stable tag family and metadata asset.

The official stable version `0.2.13` sorts above a local build based on `0.2.13`; a higher official version also remains discoverable. A lower official version does not become an automatic downgrade target. For that reason, pause automatic installation during testing: an available same-base stable release can immediately replace the local build. Use **Check for updates** and install the official release when ready to return. After restart its stable manifest no longer contains `-local`; the current UI displays the installed version, without a separate local-build badge.

Do not substitute a next-patch beta or SemVer `+local` build metadata for this convention. The former changes version precedence, and the current updater requires its SemVer-normalized version to equal the installed string. The local suffix preserves that check. Keep an unpublished next stable version out of the source manifest until preparing its formal release if the local test must offer the currently published base release.

## Publish the formal version

Use the command without `:local` only for reviewed public distribution. The command does not automatically bump a version, commit changes or push a branch.

1. Set a new stable `x.y.z` in the owning package manifest and update its release notes and affected paired documentation. A published version cannot be reused.
2. Review the intended changes, run the relevant checks, commit them and push the source branch. A dirty tree or a remote branch that differs from `HEAD` is rejected.
3. Run the formal command. It validates the package's release configuration, freezes the configured tag at `HEAD`, follows the owning native Actions workflow, verifies the public metadata and asset digests, and waits for the deployed official index to contain the exact release.
4. Accept completion only after both the public Release and official index are reported ready. Asset verification in Actions includes the complete archive; the command does not download the archive again or change immutable public attachments.

```sh
pnpm run dsh-plugin-visual-curator --plan
pnpm run dsh-plugin-visual-curator
pnpm run dsh-plugin-visual-curator --retry
```

`--plan` prints local source and version information without remote writes or credentials. Publication uses `GH_TOKEN`, `GITHUB_TOKEN` or the existing Git Credential Manager login, with Contents and Actions write permissions. It never writes credentials into artifacts. `--retry` resumes failed native jobs and dispatches the trusted official-index publisher; it never moves a tag. `--timeout-minutes` changes the bounded wait from its 60-minute default. Workflow and Release links identify failure recovery targets. A successful Release with an incomplete index is reported as incomplete publication.

The older `--prepare-only [--allow-dirty]` flags route to local packaging; prefer `:local` in scripts and daily use. `--allow-dirty` alone cannot authorize a formal release. The package's existing `release:prepare` remains the lower-level asset-preparation operation described by its release guide.

## Preview Desktop source

Desktop already has two launch commands; it does not need an installer release for each source edit:

```sh
pnpm run dev:desktop
pnpm run start:desktop
```

`dev:desktop` builds current application artifacts and the Electron shell before launching. `start:desktop` launches existing artifacts and skips that build; use it after the appropriate owner build, not immediately after editing unbuilt source. For a Visual Curator-only edit in an already built checkout, run `pnpm run build:visual-curator`, then `pnpm run start:desktop`. Application-wide changes use `dev:desktop`. See [Desktop development](../../../apps/desktop/README.md#develop) for isolated directories, environment overrides, first-run runtime preparation and debugger ports.

The development profile and browser data are separate from the normal Desktop installation by default. Do not point `DSH_HOME` at the production home for routine development. An explicitly installed same-name package can take precedence over workspace dependencies; confirm the installed source and version before concluding that an edit did not load. The development menu's refresh and restart actions do not rebuild source. Restart the Host for changed Host modules; refresh a page only when testing rebuilt Client content that does not require a Host reload.

## Verify a local test

A usable archive is not evidence that the feature works. Record the package name, local version, SHA256, running application version and install/restart result, then exercise the changed feature. For Visual Curator, verify that completed analyses become visible in the dataset list without manual refresh, an open search form updates its dataset choices, the analysis-information panel starts hidden and toggles, and a recoverable failure offers continuation. Test model-dependent results with the intended provider when accepting their output quality.

Local archives, application source preview and formal remote updates exercise different paths. The receipt states whether quick or full plugin checks ran; neither mode claims that Desktop installation, a paid-model request or the remote update path has been exercised.

## Dev Note

The following Desktop interaction is a proposed implementation plan, not a description of available controls. This change delivers commands and testing guidance; it does not add an import button or local-build badge.

- Add **Import local package** to the shared plugin-manager installation area and **Update from local package** to an installed bundle's update panel. Both enter one flow for all `dsh.bundle` packages and use the native file picker for `.tgz` and `.tar.gz` files.
- Inspect an archive in staging before installation. Show its package name, installed and candidate versions, local-build status, SHA256, compatibility and expected restart behavior. A detail-page import must match the selected package. Reuse the existing update transaction for configuration backup, feature selection, replacement, failure recovery and deferred activation; the raw installation form alone does not provide this preview and transaction.
- Derive **Local build** from the shared `-local` version convention, while continuing to show the base and full installed version. Keep that display separate from a local delivery path: an unchanged official archive downloaded to disk remains an official version. Installing a stable official manifest removes the local-build badge without a second persisted version label.
- Keep the declared official update source active. Offer a reviewed, initially selected option to pause automatic installation during the local test. Distinguish **Return to official version** for a same-base stable release from **Update to official version** for a higher release. Show progress and failures in place; close the local state only after replacement succeeds, and let the user re-enable automatic installation.
- Accept the common importer with replacement, restart, preserved feature settings, incompatible or wrong-package rejection, interrupted installation recovery, and a subsequent official update. Packages without an official update declaration can be imported but cannot gain a remote source from the file path alone.
