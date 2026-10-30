---
kind: upgrade-guide
description: AFP vision requests now use a configured native model instead of a plugin-owned endpoint and API key.
---

# AFP vision model selection

English | [中文](guide.zh.md)

## Change

AFP selects an image-capable provider and model from Settings → Models. Its native LLM adapter owns the endpoint, protocol, authentication and request defaults. AFP no longer dispatches through `visionBaseUrl` or `visionKeyRef`, or applies separate reasoning overrides. Existing reports remain readable. Resuming a report uses the current model selection; new request records retain the actual route, controls, prompt and normalized attachment reference.

## Migration

1. Configure the existing vision service in Settings → Models. For an OpenAI-compatible service, retain its endpoint, model ID and existing credential reference; enable image input. An existing `VISION_API_KEY` reference can be reused without copying its value.
2. In AFP → Vision model, select that configured model and save. Deployment overlays select the same route with `visionProvider` and `visionModel`; use the [example](../../../../custom-plugins/workspace/dsh-plugin-afp/config.example.patch.yml).
3. Old configuration fields remain accepted for reading. Without `visionProvider`, a complete model directory with one image-capable match for the previous effective ID can resolve automatically. Multiple matches, incomplete discovery or a missing model require explicit selection. No legacy endpoint or credential fallback occurs.
4. Confirm AFP offers the provider and model and can complete a small visual report. Future endpoint and credential edits belong in Settings → Models. Preview downloads and collection authentication continue to use AFP credentials.
