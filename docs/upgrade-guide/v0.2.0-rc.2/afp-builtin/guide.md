---
kind: upgrade-guide
description: "AFP ships with Web/Desktop instead of requiring a profile-local package."
---

# AFP ships with Web/Desktop

English | [中文](guide.zh.md)

## Change

The repository workspace and CLI production dependencies include `dsh-plugin-afp`. New Web/Desktop profiles select it automatically. AFP keeps its own package version and no longer declares an exact DSH peer version. Root builds rebuild its browser entry, and Desktop packages include its tarball.

## Migration

Run `pnpm install` and `pnpm run build` from the repository root, then restart the Host. Existing bundle selections stay unchanged: add `dsh-plugin-afp` to `dsh.profile.bundles` in the profile's `package.json` if you want to enable it. Keep existing user patches and feature configuration.

If the profile already installs AFP, back up its manifest and lockfile, then run `pnpm --dir <profile-directory> remove dsh-plugin-afp --config.ignore-scripts=true`. Keep AFP in `dsh.profile.bundles`; a local installed copy otherwise takes precedence over the builtin module. This package-manager command removes the old dependency without changing bundle selection or the user patch.

Keep `<profile>/.plugins/dsh-plugin-afp/config.json`, AFP state under `$DSH_HOME/.plugins/dsh-plugin-afp`, and saved credentials. Package `config.json` supplies initial feature defaults; it does not replace saved selections or create credentials. Confirm AFP mounts without a version warning and the workbench opens. Headless and SDK defaults remain unchanged.
