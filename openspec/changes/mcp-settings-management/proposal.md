## Why

MCP connections already provide tools, resources, and instructions, but users must edit YAML to manage them. Settings needs persistent controls whose connection and application outcomes remain visible to existing conversations.

## What Changes

- Add an MCP settings section with a server list, add/edit forms, enablement, connection status, tools, and restart actions using existing UI primitives and tokens.
- Persist profile-owned MCP entries through the configuration owner, including edits while disabled; preserve raw expressions and hidden credentials.
- Expose connection-owned readiness and support reconnection without recreating conversations.
- Allow an explicit application restart for configuration recovery through the owning launcher.

## Capabilities

### New Capabilities

- `mcp-settings`: Manage configured MCP servers and observe their application to existing sessions.

### Modified Capabilities

None.

## Impact

The MCP client and its optional connection registry, profile configuration editing, application restart control, one new settings package, the Web bundle and Remote assembly, focused tests, and MCP documentation. The agent loop and durable Session format remain unchanged.
