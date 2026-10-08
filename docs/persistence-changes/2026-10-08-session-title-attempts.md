---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-session-title-attempts

English | [中文](2026-10-08-session-title-attempts.zh.md)

## Summary

Adds sanitized session title attempt telemetry and optional recorded reasoning effort.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-session-title-attempts
baseline: false
changes:
  - root: "event:session/title-llm-attempt"
    previous: null
    after: "e5ae9f18f9da222773c06af817e9d4694cf85f213a03f4e462af4e4071686ed7"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "1cb6437add22641c189dc8391565e6bec6217f3530f632eef999f20767307689"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing request and title records remain readable without the new optional field or attempt events. New readers recognize the new log-only event. The writer format version and existing surface events are unchanged; no historical Session log is rewritten.

<a id="verification"></a>
## Verification

Host and Client TypeScript compilation and 86 focused tests passed, covering bounded retries, cancellation, manual renaming, Remote regeneration, and retained titles after failure. Persistence format, type-equivalence, and bilingual-pair checks passed.

<a id="dev-note"></a>
## Dev Note

None.
