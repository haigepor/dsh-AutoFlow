---
kind: upgrade-guide
description: Better Sidebar uses streamed file transfers, paged large-file previews and updated viewer and archive APIs.
---

# Better Sidebar file and viewer APIs

English | [中文](guide.zh.md)

## Change

The bundled Better Sidebar is v0.28.2. Its `readLimit`, `mediaLimit` and `uploadLimit` settings no longer limit transfers. Text files larger than 5 MiB use a read-only paged preview; smaller files remain editable. Saves use the raw `/sidebar/write` route. Downloads stream without buffering the complete file.

File viewers receive `size` and optional `largeFile` metadata instead of `truncated`, and can acknowledge line navigation with `onLineConsumed`. Archive status reports bytes rather than entry counts. Archives use the system's `zip` or `tar`; the latter produces `.tar.gz`. Closing a Side Chat tab archives its child session when the workspace service is available; persisted history remains available.

## Migration

1. Remove retired transfer limits from the Better Sidebar row in profile patches. Existing values are tolerated but no longer enforced. Keep `listLimit` and saved preferences, including `customCss`.
2. Update extensions against the bundled [viewer declarations](../../../../custom-plugins/workspace/dsh-better-sidebar/src/client/service.ts). Handle `largeFile` without assuming `content` exists; use the current [client API](../../../../custom-plugins/workspace/dsh-better-sidebar/src/client/api.ts) for writes and archive status.
3. Build and ship the sidebar and its local settings companion together with `pnpm run build:sidebar`. The companion includes the preference parser and catalog for the imported version; updating only the upstream npm package does not rebuild it.
4. Confirm task-folding switches remain selected after reopening settings, the Git/session selector and operation filters retain their local styling, and a saved file can be reopened. Verify archive downloads use the available system tool and expected extension. Existing theme tokens and profile enablement remain unchanged.
