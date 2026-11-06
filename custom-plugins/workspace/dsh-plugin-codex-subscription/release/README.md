# Codex Subscription releases

English | [中文](README.zh.md)

## Summary

Release 0.2.4: Support image editing masks and durable image-task handles. Reuse accepted operations across recovery, and preserve task ownership and cancellation receipts for canvas workflows.

This independent Host-only bundle ships with AutoFlow and uses the Installed plugins section. Existing activation choices remain unchanged. [release.config.json](../release.config.json) owns the stable `codex-subscription-v<version>` tag family and `codex-subscription-update.json` asset; AFP and application releases use separate families.

## Prepare and publish

Read the [release workflow Skill](../../../../.agents/skills/dsh-custom-plugin-release/SKILL.md) and [release policy](../../../release-governance/README.md). Review and commit the source before preparing formal assets:

```sh
pnpm --filter dsh-plugin-codex-subscription run release:prepare --out .artifacts/codex-subscription-release
```

Preparation runs the package tests and prepack, checks all declared Host/tools entries, patch, icon, locales and notices, and creates the tarball, `SHA256SUMS` and update metadata. No Client entry is required. Metadata pins the source commit, version, byte size and SHA-256; `--allow-dirty` is rehearsal only and cannot produce publishable assets. The [custom plugin workflow](../../../../.github/workflows/release-custom-plugins.yml) checks four native platforms, prepares without write credentials, then publishes a verified draft with `latest=false`. Public assets and version tags are immutable.

## Runtime updates

The plugin detail page uses the existing check, update and automatic-update controls. Automatic installation requires explicit opt-in; installation does not enable the plugin or restart AutoFlow. Restart loads the new Host implementation while retaining account credentials, gateway keys, tasks, configuration and feature choices. Runtime limits, digest verification and profile-local caching belong to the existing Plugin Manager.

The subscription settings page belongs to AutoFlow's Models package; this plugin ships its conversation image cards and live status Client. App-owned UI changes require a matching AutoFlow build. Release verification uses keyless fixtures; it does not perform real subscription login, image generation or paid calls. Download/install or old-version update acceptance is additional validation when requested.

## Dev Note

None.

## Codex Subscription 0.2.3

Codex image models can register with AutoFlow's native LLM image API for canvas workflows. The bridge reuses saved accounts, image tasks and original/preview attachments, and cancellation stops the accepted task without resubmission. Older supported Hosts keep loading the existing subscription features and report that the new image registry needs a newer AutoFlow Desktop. The matching desktop release is 0.2.2-rc.1.20261105.3.

## Codex Subscription 0.2.0

The package includes conversation image cards and live image-task status alongside its Host and tools. Account preflight and quota reporting distinguish unavailable accounts from request failures, while the relay handles streaming and WebSocket completion without turning incomplete responses into success. Saved accounts, credentials and tasks remain in their profile; use the matching AutoFlow build and restart after updating.

## Codex Subscription 0.2.1

The installed plugin list uses the updated artwork. Existing accounts, credentials, tasks and gateway configuration remain; restart after updating.
