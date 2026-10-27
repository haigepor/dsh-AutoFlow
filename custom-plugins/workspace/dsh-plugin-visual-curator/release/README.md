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
