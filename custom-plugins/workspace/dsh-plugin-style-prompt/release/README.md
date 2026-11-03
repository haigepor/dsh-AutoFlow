# Style Prompt releases

English | [中文](README.zh.md)

## Preparation and publication

Style Prompt uses the independent `style-prompt-v<version>` tag family. Its package includes Host and Client entries, the workbench, artwork, locale and profile patch. Review and commit the exact source, then run `pnpm --filter dsh-plugin-style-prompt run release:prepare --out .artifacts/style-prompt-release`. The shared release workflow checks native platforms and publishes a tarball, SHA-256 list and update metadata with `latest=false`.

## Runtime updates

The plugin page checks the package-owned GitHub source; automatic installation is opt-in and does not restart the application. Restart loads the new version while saved prompts, profile configuration and activation choices remain. Keyless package tests do not establish paid model or production image-source behavior.
