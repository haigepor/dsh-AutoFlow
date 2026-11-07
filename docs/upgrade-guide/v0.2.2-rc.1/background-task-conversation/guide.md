---
kind: upgrade-guide
description: "Background workflow conversations require a paired Host update, and their task checkpoints require a reader that recognizes session/task."
---

# Background workflow conversations

English | [中文](guide.zh.md)

## Change

Visual Curator structured workflows previously ran without conversation-body messages. They now publish durable `session/task` checkpoints and render confirmed requirements, actual requests, progress, failures and delivery in one native conversation node. Publication does not submit another prompt or repeat model work. Existing Session generations and plugin data are unchanged.

The plugin requires the Host-only `SessionController.recordTask` capability for new structured workflows. An older Desktop cannot acquire it from a plugin ZIP. The new Session reader accepts existing logs; an older reader safely refuses logs containing the new required event. See the [persistence acknowledgement](../../../persistence-changes/2026-11-06-background-task-conversation.md).

## Migration

1. Update the Desktop Host and Visual Curator together, then restart the Host. For source-based local acceptance, run `pnpm run dev:desktop` from the checkout and build the local plugin with `pnpm run dsh-plugin-visual-curator:local`. The development Desktop uses its existing isolated development profile; copy or import only the intended test data.
2. Open a workflow conversation. Its saved requirements and committed progress should appear without submitting a message. Existing workflows synchronize from saved checkpoints after restart; **Retry display sync** only republishes those facts. Continue execution through the original task control when needed.
3. Check request failures and the saved result directory in the body. Stopping or removing a workflow batch stops its execution and synchronizes its terminal state; retained conversation history remains visible. Copied task records must direct controls to their original conversation.
4. Do not reopen a Session containing `session/task` with an older reader. Keep the updated reader or use an independent pre-update profile backup when reverting the application. Do not delete or rewrite Session events to downgrade.
