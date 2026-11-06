---
kind: upgrade-guide
description: Style Prompt generation controls now follow the native model settings instead of plugin token and temperature overrides.
---

# Style Prompt uses native model settings

English | [中文](guide.zh.md)

## Change

Style Prompt previously supplied its own output limit and temperature for analysis and text generation. It now supplies only the selected provider and model, matching Visual Curator's native-model-default mode. The native LLM resolves the model's output limit, temperature and reasoning settings.

The plugin still accepts `maxOutputTokens` and `temperature` in existing profile patches, but discards them when resolving its configuration. Saved task history keeps its original request settings.

## Migration

1. Open **Settings → Models** and configure the output limit and other controls on each model used by Style Prompt.
2. Remove optional `maxOutputTokens` and `temperature` keys from the `style-prompt` entry in `cordis.patch.yml` or launch overlays. Existing patches still load when those keys remain.
3. Restart the application and explicitly run the analysis or prompt node again. A new task's saved request uses the selected native model settings; old failed tasks remain unchanged. Truncated responses still fail validation and are never retried automatically.
