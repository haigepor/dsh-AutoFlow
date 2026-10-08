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

## Updates and recovery

These assets provide a versioned GitHub distribution channel. The current plugin page does not query this channel or install updates automatically. The root `pnpm install` uses the workspace and lockfile; repository updates plus a build update the builtin AFP. Future runtime updates need a shared version choice for bundle metadata, patch, Host, Client and resources, with user-owned installation storage and configuration migration.

A failed draft can be inspected and recovered before publication after checking its tag and uploaded bytes; do not silently overwrite assets or delete an unrelated Release. Correct a published defect with a new package version and tag. Preserve the previous tarball and users' feature choices, credentials and reports; a package downgrade cannot undo an irreversible data migration.

## Dev Note

None.
