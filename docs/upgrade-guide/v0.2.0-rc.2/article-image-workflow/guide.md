---
kind: upgrade-guide
description: "The article image bundle and toolkit are removed; existing profiles must remove their bundle and patch entries."
---

# Remove the article image plugin from existing profiles

English | [中文](guide.zh.md)

## Change

The application no longer ships `dsh-plugin-article-image` or `article-image-toolkit`. New Web and Desktop profiles omit the bundle. The article workbench, article tools, bundled editorial Skills, capture queues and image planning are unavailable. Existing profile files are user-owned and require the cleanup below.

## Migration

1. Stop the affected Host and preserve its profile files and article data before editing configuration.
2. In `$DSH_HOME/profiles/<profile>/package.json`, remove `dsh-plugin-article-image` from `dsh.profile.bundles` and from `dependencies` if present. Remove an independently installed `article-image-toolkit` dependency if it is no longer used.
3. Remove patch rows with ids `article-image`, `article-image-tools`, `article-image-ui`, `article-image-ui-settings`, `article-image-ui-conversation` and `article-image-skills` from profile, home and command-line overlays. Remove standalone toolkit MCP launch entries from clients that configured them.
4. Restart the profile. Confirm that it starts without missing-plugin or missing-row errors and no longer offers the article workbench or article tools.
5. Article data under `$DSH_HOME/.plugins/dsh-plugin-article-image/profiles/` remains on disk. Standalone toolkit data defaults to `.article-image`, unless overridden by `--data-dir` or `ARTICLE_IMAGE_DATA_DIR`. Removing application code does not delete these records. Preserve a complete copy if needed; deleting these directories permanently discards their articles, originals and plans. Historical Session logs remain owned by the Session system.
