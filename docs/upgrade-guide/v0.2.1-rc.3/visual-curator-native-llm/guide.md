---
kind: upgrade-guide
description: Visual Curator defaults new tasks to registered native LLM routes instead of its direct HTTP model endpoint.
---

# Visual Curator native LLM routing

English | [中文](guide.zh.md)

## Change

Visual Curator defaults new task configurations to `vision.backend: native`. The Host must mount `llm` and `attachments`. A plugin endpoint and credential alone no longer configure the default route. Existing frozen tasks without a backend retain their original compatible HTTP behavior, and saved observations remain readable. Selecting a different backend creates a different reviewer identity; published standards are not silently rewritten.

## Migration

1. In the project's Models settings, configure an image-capable native provider and model. Keep credentials in the native credential service.
2. In Visual Curator model settings, select **Native LLM**, fill `vision.provider` with that provider route identifier, and set `vision.model` to the exact model identifier. Keep a supported reasoning effort, then save. Invalid routes or missing image capability are refused before analysis starts.
3. For a deployment that must keep direct HTTP calls, explicitly select **Compatible HTTP interface** or set `vision.backend: compatible` in its profile overlay. Existing endpoint and credential fields remain the backup configuration. Failure does not automatically send the request through both transports.
4. Run a small analysis. Confirm the native provider and reported token usage in its analysis sidebar, streaming reasoning/text when returned, and one final summary. When the backend changes, regenerate and review the standard before new formal search/crop tasks; older task records remain available.
5. Unsplash previews now return authorized bytes through the Host by default, with bounded system/HTTPS DNS failover. Configure `source.unsplash.mediaDnsResolvers` for the deployment, or use an empty list to disable external DNS fallback. Select `source.unsplash.previewTransport: redirect` only when browser-side CDN routing is required. Operating-system DNS and hosts files are not modified.
