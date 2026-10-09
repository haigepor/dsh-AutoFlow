# Publishing AFP releases

English | [中文](README.zh.md)

## Summary

Publish an independent AFP package from this repository to GitHub Releases. The package version owns the `afp-v<version>` tag; AFP does not share the application's release version or latest marker. [release.config.json](../release.config.json) owns the repository, tag prefix and stable channel. Use the [release Skill](../../../../.agents/skills/dsh-custom-plugin-release/SKILL.md) for the complete execution and verification procedure.

## Prepare the source

Use the repository's Node.js and pnpm versions, Git and GitHub CLI with write access to the configured repository. Read [UPSTREAM.md](../UPSTREAM.md) and retain source attribution; this flow does not publish to npm or infer a license for adapted third-party code. Review the intended source changes, update `package.json` for a new version, update the README pair, and commit before preparing the final assets. Never overwrite a previously released version or move its tag.

From the repository root, prepare the committed version:

```sh
pnpm --filter dsh-plugin-afp run release:prepare --out .artifacts/afp-release
```

The command runs AFP tests, builds and checks the package through `prepack`, validates tarball paths and declared entries, and writes three assets: `dsh-plugin-afp-<version>.tgz`, `SHA256SUMS` and `afp-update.json`. The JSON records the exact source commit, tag, download URL, SHA-256 and byte count. `--tag afp-v<version>` verifies a requested tag. `--allow-dirty` is for local rehearsals only: it marks metadata as dirty, and the publisher refuses it.

## Publish and verify

Push the reviewed source and a new `afp-v<version>` tag to the configured repository. The [AFP workflow](../../../../.github/workflows/release-afp.yml) builds from that tag, checks the package version and source commit, prepares assets without write credentials, then uploads a draft with a separate publication job. It locates drafts by Release ID and publishes only after asset checks pass, with `latest=false`. Manual dispatch from the current workflow takes an existing AFP tag as input and builds that tag's source. Matching existing assets are verified without replacement; missing or different assets stop publication.

After the workflow succeeds, inspect the Release, its three uploaded assets and tag commit. Download the `.tgz`, `SHA256SUMS` and `afp-update.json` into a new directory; recompute SHA-256 and check the metadata's version, source commit and size. Test the downloaded package in a disposable DSH profile using the supported `dsh` launcher; check Host entries, bundle features, Client resources and retained configuration. Do not install over an existing builtin AFP solely to test the tarball.

After creating a draft, the publisher retries its Release ID lookup for up to 20 seconds. If the draft remains unavailable, publication stops without creating another draft or replacing assets. Recover through manual dispatch using the existing tag after checking its source and uploaded bytes.

## Updates and recovery

These assets provide a versioned GitHub distribution channel. AFP declares its repository, `afp-v` tag family and `afp-update.json` asset under `dsh.bundle.update`. The [plugin manager](../../../../packages/boot/plugin-manager/README.md) checks automatically and installs automatically only after explicit opt-in; restart applies the update while retaining configuration. Root `pnpm install` still uses the workspace and lockfile. Plugins and Desktop publish independently; historical tags and Releases follow the [release governance guide](../../../release-governance/README.md).

A failed draft can be inspected and recovered before publication after checking its tag and uploaded bytes; do not silently overwrite assets or delete an unrelated Release. Correct a published defect with a new package version and tag. Preserve the previous tarball and users' feature choices, credentials and reports; a package downgrade cannot undo an irreversible data migration.

## AFP 0.1.1

Conversation feedback presents visual review as inline disclosures. Accepted and rejected photos have independent image lists with at most five visible thumbnails and horizontal scrolling; previews reuse the workbench dialog. Preview reads, completed pixel judgments and request failures are counted separately. Repeated identical reports consolidate their summary while retaining the tool inspector records. The redundant AFP composer capsule is no longer registered.

Visual dry-runs persist preparation stages, report connection and collection progress, bound each preparation stage with the configured request timeout, and reject a duplicate resume of a busy run within one Host. The six DSH Skills create and maintain a task checklist before AFP work, reserve goals for genuinely large resource objectives requiring continuation, and preserve user-customized installed instructions. Final selection still requires a successful save; neither preview reads nor a screening report imply that final photos have been saved.

The package retains existing configuration and stable update-source fields. Restart applies an installed update. Shared application changes to task icons, hover width, queue animation and the combined queue/goal header are source changes in AutoFlow; updating only this AFP tarball does not install those application components. Verification uses keyless recorded Sessions, simulated AFP/vision providers and isolated profiles; it does not establish production AFP or real-model visual accuracy.

## AFP 0.1.2

This version fixes Windows checkpoint replacement with bounded retries that preserve the previous record. macOS accepts only the system `/var` and `/tmp` aliases without relaxing user-directory link checks. Publication requires passing native AFP regressions on Windows x64, Linux x64, macOS arm64 and macOS x64.

Screening checkpoints each photo result and landscape confirmation; resuming reuses completed judgments. Collection reads and candidate queries have bounded concurrency and budgets. Transport and body reads share a retry budget rather than multiplying retries. Agents can request retained-photo and minimum-completed-judgment counts; insufficient results remain incomplete and never save an empty selection as success.

Run diagnostics retain the current attempt's total duration, individual stage timings and sanitized failure locations. Debug adds only bounded detailed events. Blocked CDN previews report an exact hostname for verification and deployment `previewCdnHosts` configuration; arbitrary redirects and forwarding AFP credentials to CDNs remain prohibited.

The workbench updates task, report, collection-change history and configuration layouts, with diagnostic tags, timing tables, run identity cards and log export. Left-click opens large-image review; right-click opens details. Review supports keyboard navigation and selecting passed photos while preserving automatic judgments, without manual overrides. Adding photos uses a scoped frosted-glass modal and still requires explicit confirmation. The rotating task icon, fixed-width task panel and update loading animations require an AutoFlow application containing these changes; the plugin bundle does not replace application components.

## Dev Note

None.
