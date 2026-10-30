---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-28-native-model-web-search

English | [中文](2026-10-28-native-model-web-search.zh.md)

## Summary

Records auxiliary model-native web-search input before provider dispatch.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-28-native-model-web-search
baseline: false
changes:
  - root: "event:web/native-search-llm-request"
    previous: null
    after: "7195fba1ffaa67e485ea93f1d2231fbda86babc0d7c5ea72ae8b26c70a869b58"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session records remain valid. The new web/native-search-llm-request discriminator records secret-free auxiliary input and does not alter conversation message projection. Older readers that do not know this required event refuse it rather than misinterpret another event. No released generation or existing discriminator changes.

<a id="verification"></a>
## Verification

pnpm run build:check passed both aggregate checks. The tool-web native-search test records and snapshots the new event before dispatch. Direct DeepSeek, Responses and Codex account fixtures verify current-model credentials and structured sources.

<a id="dev-note"></a>
## Dev Note

None.
