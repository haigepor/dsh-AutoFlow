---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-background-task-conversation

English | [中文](2026-11-06-background-task-conversation.zh.md)

## Summary

Adds durable, display-only session/task checkpoints for Host-owned background workflows.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-background-task-conversation
baseline: false
changes:
  - root: "event:session/task"
    previous: null
    after: "4a98531bdd213d072f55eec3c8fd13431abddb93ba86066e5bf2429a054b40bd"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session generations and event payloads are unchanged. New readers accept logs without task checkpoints and preserve their previous behavior. The new required event has a distinct session/task discriminator: older readers refuse it through required-event feature detection before replay; it must not be treated as corruption or a truncatable tail. Checkpoints contain presentation facts, not model-visible input or execution commands. Copying preserves the original owner and never transfers task control. Producer source revisions deduplicate uncertain persistence acknowledgements. SESSION_FORMAT_VERSION remains unchanged.

<a id="verification"></a>
## Verification

Focused native Session Controller Host and Visual Curator Host/Client TypeScript checks passed before recording. Regression source covers duplicate checkpoints, failed persistence acknowledgement, original-owner retention, pre-dispatch display, display-only retries and stopped-task refusal. Tests, builds, paid calls and runtime UI validation were not run at the users request.

<a id="dev-note"></a>
## Dev Note

None.
