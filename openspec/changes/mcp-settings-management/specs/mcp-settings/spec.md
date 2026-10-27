## ADDED Requirements

### Requirement: MCP settings navigation and list
Settings SHALL expose an MCP section under Models and agents using the existing visual system and list configured servers including disabled and failed entries.

#### Scenario: Navigate to MCP
- **WHEN** the user opens the MCP settings section
- **THEN** the page shows configured server names, transport, connection state, enablement, and discovered tools without exposing credentials

#### Scenario: Read configuration guidance
- **WHEN** the user opens MCP settings or clicks its help control
- **THEN** the page places its decorative artwork left of the introduction, provides the existing-session guidance, and omits the configuration-file action

### Requirement: JSON configuration management
Users SHALL view, edit, and merge MCP JSON declarations in a modal using the project's syntax highlighting and theme tokens.

#### Scenario: Merge JSON configuration
- **WHEN** valid mcpServers JSON is saved
- **THEN** named existing entries are edited with their original revisions, new entries are added, omitted entries remain configured, and null saved credentials are retained

#### Scenario: Recover from invalid or partial import
- **WHEN** JSON is invalid or a later independent server write fails
- **THEN** the editor retains its draft and reports the failure and any partial progress for explicit review

### Requirement: Persistent server management
Users SHALL add, inspect, edit, enable, and disable profile-owned stdio and Streamable HTTP servers with host validation and visible failures.

#### Scenario: Edit a disabled server
- **WHEN** a valid edit is saved for a disabled server
- **THEN** the configuration is persisted without starting the server and retained credentials are unchanged

#### Scenario: Reject an invalid or stale edit
- **WHEN** the server declaration is invalid, overridden, duplicated, or stale
- **THEN** the operation reports failure without replacing the previous valid configuration

### Requirement: Existing sessions observe management changes
Existing sessions SHALL use updated caller-visible tools on subsequent model steps without replacing their identity or history.

#### Scenario: Add and disable in an existing session
- **WHEN** a server connects and is later disabled
- **THEN** the same session first sees its tools and subsequently cannot execute them, while its history remains intact

### Requirement: Explicit restart and readiness
The page SHALL provide server restart and explicit application restart actions and SHALL distinguish persisted settings from successful connection and discovery.

#### Scenario: Restart a server
- **WHEN** the user restarts an enabled server
- **THEN** its old connection is disposed before the replacement connects and the UI reports the replacement's actual readiness

#### Scenario: Restart the application
- **WHEN** an available owning launcher accepts an explicit restart
- **THEN** the application reloads saved configuration while historical conversations remain available
