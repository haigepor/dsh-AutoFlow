---
kind: upgrade-guide
description: "Article image processing uses rich browser snapshots, explicit analysis models and a separate profile index."
---

# Article image workflow and profile records

English | [中文](guide.zh.md)

## Change

The article-image bundle uses `article-image-toolkit/capture` to capture rich text and original images, then starts dedicated analysis sessions. Processing no longer means fetching plain text for manual copying into chat. Configure an explicit analysis provider/model and a usable Chromium installation. Unknown publisher templates require source review; known missing content prevents analysis. Human review remains the endpoint; no image generation or publication is connected.

Profile records use `state.v2.json` plus immutable artifact collections. Existing `state.json` remains untouched and has a digest-named copy under `legacy/`. Old text, plans and approvals remain readable as history but cannot approve a new rich-source plan. Native `article_image_save_plan` accepts the structured analysis result; a legacy plan is rejected with `legacy-needs-refetch`. Standalone toolkit MCP retains its separate schema:1 text workflow.

## Migration

Workbench progress records include safe root-cause fields and image download/decode timings. Earlier schema:2 readers with strict diagnostic validation can reject these fields; a downgrade must restore the complete pre-upgrade profile backup. New optional controls are `progressBatchSize`, `progressFlushMs`, `capture.imageConnectionPoolSize` and `capture.maxImageTransportRetries` (default 1, range 0–2); defaults require no patch changes. Pool size 0 disables article image connection reuse while retaining request limits and public-network checks.

Publisher adapters may opt into `captionSources` and exact HTTPS `imageRedirects`; these remain disabled when omitted. `capture.maxCaptionCues` defaults to 2000. Downgrading to a strict older config reader requires removing these optional settings from the profile patch. Subtitle text is added to the source hash, so recapture and repeat source/plan review; existing approvals do not approve added captions.

Browser connection reuse uses `capture.rendererConnectionPoolSize` (default 8; 0 disables reuse) and `capture.rendererConnectionsPerOrigin` (default 4). Optional adapter `browserResources.deferTypes` and `static` require publisher validation; omission retains full browser loading. Use adapter `pathPrefixes` to scope template-specific rules on shared hosts. Optional `capture.imageMetadataSources` (default `[]`) fills empty image descriptions from identity-checked publisher metadata; accepted descriptions require renewed source/plan review. Review safety and completeness conditions in the [capture reference](../../../../custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/README.md#shared-rich-capture-api). Remove both renderer settings, adapter fields including `pathPrefixes`, and `imageMetadataSources` before downgrading to a strict older config reader.

1. Stop the plugin and preserve its entire profile data directory under `$DSH_HOME/.plugins/dsh-plugin-article-image/profiles/`.
2. Install both bundle and toolkit production packages. In the `article-image` Cordis row, set `analysis.provider` and `analysis.model` to a configured DSH route; image-bearing articles need image input and the attachment service. Review limits and publisher adapters in the [package reference](../../../../custom-plugins/workspace/dsh-plugin-article-image/README.md).
3. Open the workbench and inspect browser/model readiness. Recapture legacy articles, review uncertain source boundaries and confirm that understanding and prompts reach `review` before approving. Retained legacy approval does not approve the new plan.
4. To roll back, stop the plugin, keep the new data directory, and run the old package with the unchanged `state.json` or its `legacy/` copy. Do not rename `state.v2.json` to `state.json`; old packages cannot read that format.
