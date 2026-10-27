---
description: "Manage profile MCP servers from Settings and observe their live connections."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-mcp

English | [中文](README.zh.md)

## Summary

Settings → MCP servers lists configured local programs and remote services with enablement, connection readiness, and discovered tools. The shipped Web composition includes this page; Desktop uses the same composition.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Add MCP opens a stdio or Streamable HTTP editor. Save validates and persists the entry in the active profile patch before reconciling its plugin. Disabled servers remain editable. Environment and header values never return to the page: unchanged saved keys are retained, entered values replace them, and removing a key deletes it. Untouched raw expressions remain expressions.

The enablement switch controls the configured plugin. Connection readiness is separate: a saved, enabled server can still be connecting or disconnected. Restart server tears down that connection and waits for its replacement. Existing conversations use the caller-visible tool registrations on subsequent model steps, retaining their identity and history.

Restart and apply requests an explicit application restart through its owning launcher. Conversation history remains persisted; running tasks stop and are not replayed automatically. A launcher without restart support refuses the operation visibly.

<a id="understand-the-implementation"></a>
## Understand the implementation

The Host [MCP manager](../../mcp/mcp-manager/README.md) owns validated `mcpSettings` Remote operations. ConfigEditor owns atomic profile edits and rollback; PluginManager owns persistent enablement and launcher restart. The optional MCP connection registry supplies readiness by Fiber identity. Client resource providers publish redacted list and detail snapshots; one declared store shares operation feedback with the application overlay. Detail revisions reject stale saves.

The MCP section omits the shared configuration-file footer. Its introduction places the existing whale maid identity beside configuration guidance and an accessible help control. The generation prompt is retained beside the transparent WebP asset; the image is decorative and absent from the accessibility tree.

Help uses the same click-open speech bubble and menu material as Models. Transport selection uses the shared Menu, advanced fields use AnimatedCollapse, and loading states reserve list-row or editor geometry with the theme skeleton color and reduced-motion support.

The JSON action opens the current redacted `mcpServers` document in the shared Shiki-highlighted CodeEditor. Imports merge named stdio or HTTP declarations; omitted servers remain configured, `disabled` controls enablement, and null secret values retain existing keys. Editing retains editor-open revisions and untouched expressions. Each server uses the existing management operations; a failed batch stops and reports partial progress for explicit reload and review.

JSON imports reject HTTP URLs containing usernames or passwords before producing edits. Authentication values belong in protected headers and remain hidden in later reads.

<a id="further-exploration"></a>
## Further Exploration

- [MCP](../../../docs/subsystems/mcp.md) — transport, tool scope, resources, and instructions.
- [MCP client](../../mcp/mcp-client/README.md) — server configuration and connection behavior.
- [ConfigEditor](../../boot/config-editor/README.md) — profile persistence and reconciliation.

<a id="model-experience"></a>
## Model Experience

### Configuration changes

#### What the model sees

The `settings.section` page contributes no model input. Managed servers contribute tools and instructions through the MCP client, subject to the caller's scope and restrictions.

#### Token effect

The page adds no tokens; the enabled server's tools and instructions determine their own request cost.

#### KV Cache effect

Tool and prompt changes follow the existing agent-loop request history; the page adds no model input of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only addressable profile entries can be edited; ACP-owned declarations remain owned by their session request.
- Server executable installation and provider authentication setup remain external to this page.
- Already issued model requests cannot retroactively receive changed tool schemas.

<a id="dev-note"></a>
### Dev Note

Connection activation alone is not readiness: use the connection snapshot after discovery. Configuration recovery must not use the upgrade-only restart admission rule.
