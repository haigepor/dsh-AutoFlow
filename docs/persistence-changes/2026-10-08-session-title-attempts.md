---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-session-title-attempts

English | [中文](2026-10-08-session-title-attempts.zh.md)

## Summary

Retains sanitized local session-title attempt telemetry alongside the official title request declaration.

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
```

<a id="compatibility"></a>
## Compatibility

The title request type matches the official declaration and needs no additional fork transition. This local acknowledgement adds only the log-only attempt event, which does not enter model input. Older readers that do not know this required event refuse the Session. Official acknowledgements, the writer version, and committed historical Session generations remain unchanged.

<a id="verification"></a>
## Verification

pnpm exec tsx scripts/compile-referenced-projects.ts host-contracts and pnpm exec tsc -b tsconfig.client.json passed. The focused session-title-llm llm.spec.ts run passed 20 tests, including bounded transient retries, terminal authentication failures, cancellation, operational stream failures, sanitized attempt records, and provider reasoning selection.

<a id="dev-note"></a>
## Dev Note

None.
