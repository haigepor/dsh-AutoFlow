---
description: "Manage profile MCP entries and report redacted connection readiness."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

English | [中文](README.zh.md)

## Summary

The `mcpSettings` Host service manages profile-owned MCP entries for the [MCP settings page](../../client/ui-settings-mcp/README.md). It exposes redacted list and detail records, validated creation and editing, persistent enablement, and connection restart.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The shipped Web composition mounts this service together with the MCP connection inventory and configuration owners. Callers read a detail revision before editing. Hidden environment and header values use null keep markers; a supplied literal replaces its key. Editing a disabled entry does not start its server. Connection readiness remains separate from successful persistence.

HTTP endpoints reject embedded usernames or passwords before persistence; authentication belongs in protected headers. Invalid endpoint diagnostics return only the structured failure code.

<a id="understand-the-implementation"></a>
## Understand the implementation

ConfigEditor serializes atomic profile writes, validates inactive edits through the owning MCP schema, rejects ineffective higher-layer overrides, and restores failed reconciliations. PluginManager supplies persistent enablement. Connection restart waits for the owning Fiber's unload and replacement activation without replacing conversations. List and detail responses exclude credential values; `mcp-settings/changed` invalidates their client resources.

<a id="model-experience"></a>
## Model Experience

### Managed server contributions

#### What the model sees

The `mcpSettings` manager adds no model input. Managed servers contribute through the [MCP client](../mcp-client/README.md), whose caller scope and tool restrictions remain authoritative.

#### Token effect

The manager adds no tokens; each enabled server determines its tools and instructions.

#### KV Cache effect

Existing agent-loop tool and prompt change recording determines request cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only addressable current-profile entries are editable; ACP-owned declarations remain request-owned.
- This service does not install server executables.
- Already issued model requests retain their original tool schemas.

<a id="dev-note"></a>
### Dev Note

Connection inventory is optional for ordinary MCP clients and required by this management service. Public configuration values come from the MCP client's schema; the manager retains raw fields that the editor did not change. The [MCP subsystem](../../../docs/subsystems/mcp.md) owns connection and resource semantics.
