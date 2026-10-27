# Codex Subscription releases

English | [中文](README.zh.md)

## Summary

This independent Host-only bundle ships with AutoFlow and uses the Installed plugins section. Existing activation choices remain unchanged. [release.config.json](../release.config.json) owns the stable `codex-subscription-v<version>` tag family and `codex-subscription-update.json` asset; AFP and application releases use separate families.

## Prepare and publish

Read the [release workflow Skill](../../../../.agents/skills/dsh-custom-plugin-release/SKILL.md) and [release policy](../../../release-governance/README.md). Review and commit the source before preparing formal assets:

```sh
pnpm --filter dsh-plugin-codex-subscription run release:prepare --out .artifacts/codex-subscription-release
```

Preparation runs the package tests and prepack, checks all declared Host/tools entries, patch, icon, locales and notices, and creates the tarball, `SHA256SUMS` and update metadata. No Client entry is required. Metadata pins the source commit, version, byte size and SHA-256; `--allow-dirty` is rehearsal only and cannot produce publishable assets. The [custom plugin workflow](../../../../.github/workflows/release-custom-plugins.yml) checks four native platforms, prepares without write credentials, then publishes a verified draft with `latest=false`. Public assets and version tags are immutable.

## Runtime updates

The plugin detail page uses the existing check, update and automatic-update controls. Automatic installation requires explicit opt-in; installation does not enable the plugin or restart AutoFlow. Restart loads the new Host implementation while retaining account credentials, gateway keys, tasks, configuration and feature choices. Runtime limits, digest verification and profile-local caching belong to the existing Plugin Manager.

The subscription page belongs to AutoFlow's Models package and is not shipped by this Host-only tarball. UI changes require a matching AutoFlow build. Release verification uses keyless fixtures; it does not perform real subscription login, image generation or paid calls. Download/install or old-version update acceptance is additional validation when requested.

## Dev Note

None.
