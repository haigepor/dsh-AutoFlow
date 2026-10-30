---
kind: upgrade-guide
description: "Codex subscription model discovery requires explicit profile choices before models appear in application and relay catalogs."
---
# Select Codex subscription models explicitly

English | [中文](guide.zh.md)

## Change

The Codex subscription plugin exposes only the text models selected in `options.catalog` through AutoFlow and `GET /v1/models`. Account sign-in and `model-list` still discover upstream candidates, but do not add them to these catalogs. Existing accounts, credentials, current model targets and prepared requests remain intact. Image models use the image tools and MCP; adding one does not change the image default.

## Migration

1. Open Settings → Models → ChatGPT subscription → Add model. Choose the text models to expose, or manage image model IDs there. Enable the image-default switch only when changing that target.
2. Method callers read `model-catalog`, then call `model-catalog-save` with its `revision` and complete `entries` containing `kind`, `id` and `name`. Profile editors can set `options.catalog` in the `codex-subscription` row of `cordis.patch.yml`. Preserve other options.
3. Check the selected text models in the Model catalog and Providers tabs, or in the authenticated relay's `GET /v1/models`. An empty selection intentionally exposes no text models; stored accounts remain available under ChatGPT subscription.
