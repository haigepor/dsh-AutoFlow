---
kind: upgrade-guide
description: "AutoFlow plugin integrations must separate Release updates from registry and Git updates and select the profile MCP settings entry."
---

# AutoFlow plugin management

English | [中文](guide.zh.md)

## Change

`BundleInfo.update` now identifies the official update mechanism as `registry` or `git`. AutoFlow's independent GitHub Release status moves to `BundleInfo.releaseUpdate`. The plugin page projects these into `PackageView.updateKind` and `PackageView.update`, respectively.

The default `@deepseek-ai/dsh-mcp-manager` entry provides the official dynamic server fleet. AutoFlow's profile connection editor remains available through `@deepseek-ai/dsh-mcp-manager/settings` as `ctx.mcpSettings`. Existing direct MCP client entries and their saved secrets remain in the profile.

Pure helpers no longer load a plugin entry: skill document parsing uses `@deepseek-ai/dsh-skill-filesystem/document`, and native image/reference choosers use `@deepseek-ai/dsh-host-directory-picker-native/native-picker`. Theme constants remain in the package's `src/theme-settings.ts` source export and Client API; preview limits and title normalization helpers stay internal. `SkillManagement.Config` owns the management plugin's schema.

GitHub Desktop publication keeps development metadata in `nightly.yml` and `policy.json`, and stable metadata in `stable.yml` and `policy-stable.json`; macOS feed names include `-mac`. Signing isolation remains independent of this selection.

## Migration

1. Update custom inventory consumers to read independent Release progress from `releaseUpdate`; use `update` only for registry or Git eligibility.
2. Compositions using profile connection editing must load the `/settings` entry once. Load the default manager once for configured or plugin-registered fleet entries. Do not duplicate or move saved direct MCP clients into the fleet.
3. For GitHub Desktop publication, select `DSH_DESKTOP_UPDATE_CHANNEL` before building and publishing. Use the matching completion record and preceding channel policy. Publish both tracks before expecting both settings choices to offer a download.
4. Confirm the plugin page still reports Release progress and restart requirements, profile MCP editing retains its connections, and changing Desktop channels checks the corresponding feed without installing an old-channel download.
5. Rebuild custom plugins against the new helper subpaths. Same-package tests import internal helpers directly; avoid importing plugin entries for pure parsing or defaults.
