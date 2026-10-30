---
kind: upgrade-guide
description: Known models can select native web search automatically and record a new Session event.
---

# Model-native web search

English | [中文](guide.zh.md)

## Change

Previously, `web_search` always used the configured web provider. Models with matched native-search support now use their own provider and credentials unless their model entry sets `nativeWebSearch: false`. Unknown models stay on the configured provider; unsupported protocols cannot enable native search. Provider-reported defaults captured during model discovery are stored separately from the user override.

Native calls record `web/native-search-llm-request`. Existing Sessions remain readable; older readers that do not recognize this required event refuse new logs containing it. The [persistence acknowledgement](../../../persistence-changes/2026-10-28-native-model-web-search.md) records the same-version decision.

## Migration

1. Update Session readers together with the application before opening logs containing native searches.
2. Open Models, edit a model, and review Model capabilities > Native web search. To keep the previous search backend, clear the checkbox; this saves `nativeWebSearch: false` on that model. Use automatic matching removes the manual override.
3. For Codex subscription text models, review the same option in the subscription model editor. Searches reuse the selected account and do not need a DeepSeek key. Search support now participates in account capability groups; if a saved `dsh-cap:…` alias becomes unavailable after discovery, reselect its current group. Upstream model IDs remain unchanged.
4. Save and reopen the model to confirm the selection. A search should return source URLs; a provider rejection remains visible without switching to another credential.
