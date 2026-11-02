# Visual Curator releases

English | [中文](README.zh.md)

## Summary

AutoFlow ships this independent bundle and lists it under Installed plugins. Existing activation choices remain unchanged. [release.config.json](../release.config.json) owns the stable `visual-curator-v<version>` family and `visual-curator-update.json` metadata, separately from AFP and application releases.

## Prepare and publish

Read the [release workflow Skill](../../../../.agents/skills/dsh-custom-plugin-release/SKILL.md) and [release policy](../../../release-governance/README.md). Review and commit the source, then prepare:

```sh
pnpm --filter dsh-plugin-visual-curator run release:prepare --out .artifacts/visual-curator-release
```

Preparation runs package tests and prepack, verifies the Host, Client, tools, skills and page entries, patch, icons, locales and notices, and creates the tarball, `SHA256SUMS` and update metadata. Metadata fixes the source commit, version, byte size and digest. `--allow-dirty` permits local rehearsal only. The [custom plugin workflow](../../../../.github/workflows/release-custom-plugins.yml) checks four native platforms and publishes a verified draft with `latest=false`; public assets and tags remain immutable.

## Runtime updates

The plugin detail page uses the existing check, update and automatic-update controls. Automatic installation requires explicit opt-in; it does not restart the application. Restart loads the matching Host, Client and profile patch together. Saved styles, references, tasks, feedback, model settings, credentials, activation and feature choices remain in their owning profile storage.

The tarball requires the native LLM, attachment, jobs, storage and Client capabilities declared by its peer dependencies. App-owned components require a matching AutoFlow build. Keyless release tests do not validate live image-source login, paid vision calls or source permissions. Download/install and old-version update acceptance are additional checks when requested.

## Dev Note

None.

## Visual Curator 0.2.0

Reference imports run in the background, retain committed images after interruption and resume remaining work. Completed searches can supply positive or negative references across tasks. Dataset export distinguishes complete style packages from role-specific observation packages, and search preparation includes current negative evidence and historical exclusions.

Search queries and visual reviews enforce subject prominence before accepting a style match. The workbench adds paginated, virtualized image lists, responsive conversation task cards and incremental analysis refreshes with current context usage. Repeated reference validation, dataset serialization and preview concurrency are reduced without removing authorization, checksums or per-image commits. Saved profile data remains in place; app-owned UI and native capabilities require the matching AutoFlow build, followed by restart.
