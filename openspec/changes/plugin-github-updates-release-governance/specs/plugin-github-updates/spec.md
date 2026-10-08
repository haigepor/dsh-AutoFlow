## ADDED Requirements

### Requirement: Stable source-specific discovery

The manager SHALL check the GitHub source declared by a bundle, select the newest stable SemVer in that tag family, and distinguish available, current, and failed checks.

#### Scenario: Mixed repository releases
- **WHEN** AFP, Desktop, draft and prerelease entries appear together
- **THEN** AFP discovery considers only published stable AFP tags with matching metadata and assets

#### Scenario: Offline check
- **WHEN** GitHub returns a network error or rate limit
- **THEN** the installed package remains available and the page offers a retry rather than claiming it is current

### Requirement: Verified profile update transaction

The manager MUST validate metadata identity, allowed URLs, download bounds, size, hash and tar package identity before installation, retain user configuration and activation, restore failed changes, and report restart-required after successful updates.

#### Scenario: Valid newer package
- **WHEN** a matching newer release is installed
- **THEN** its validated tarball becomes a profile dependency, retained feature choices remain, and the running process is not hot-swapped

#### Scenario: Invalid artifact
- **WHEN** digest, size, package name, version, paths or tar entry types are invalid
- **THEN** no pnpm update is started and the previous package and configuration remain selected

#### Scenario: Failed or stopped installation
- **WHEN** pnpm fails or the owner is disposed during installation
- **THEN** the operation settles, modified package metadata and the prior target entry are restored, and no successful update is reported

### Requirement: Consistent custom builtin resolution

An installation-provided custom bundle declaring an update source SHALL resolve an explicitly installed profile copy consistently for patch, Host, Client, metadata and resources after restart; official runtime packages MUST retain installation precedence.

#### Scenario: Updated builtin AFP
- **WHEN** AFP is present in both installation and profile
- **THEN** its declared update capability selects the profile copy for all managed consumers after restart

#### Scenario: Foundation copy in profile
- **WHEN** a profile contains a copy of an official foundation package
- **THEN** bundle loading retains the installation package

### Requirement: Opt-in automatic installation

The manager SHALL check automatically, default automatic installation to false, persist a per-profile user choice, and install available updates only when enabled.

#### Scenario: Default check
- **WHEN** a managed profile starts or the user opens plugin updates without a saved choice
- **THEN** available versions are checked but no automatic installation starts

#### Scenario: Enabled automatic updates
- **WHEN** the user enables automatic updates and a newer stable version is available
- **THEN** the manager installs it through the verified transaction and displays that restart is required

### Requirement: Update actions and global completion

The Client SHALL present an actionable version badge in the plugin list and a folded update section in details, retain installation progress against older check results, and display completion through a global restart dialog.

#### Scenario: Completion outside Plugins
- **WHEN** an explicitly permitted automatic update completes after the user leaves Plugins
- **THEN** the global dialog identifies the installed plugin version without restarting automatically

#### Scenario: Deferred restart
- **WHEN** the user selects later
- **THEN** the dialog closes while the pending-restart badge remains and can reopen the dialog

### Requirement: Explicit fresh-process restart

One-click restart MUST replace the Host process rather than refreshing a Session or module service. It SHALL retain persisted profile configuration and Sessions, disclose interruption of running work, and require explicit user confirmation.

#### Scenario: Managed Web restart
- **WHEN** an authenticated user confirms a pending update with no active package operations
- **THEN** the owning launcher waits for the old Host to exit, starts the same invocation at the same origin, and the Client reloads only after a different process identity reports ready

#### Scenario: Service reload or failed shutdown
- **WHEN** a service reloads inside the same process, cleanup fails, or the user interrupts the launcher
- **THEN** service reload does not change the process identity and failure or interruption does not spawn a replacement

#### Scenario: Desktop confirmation
- **WHEN** the application main frame requests restart
- **THEN** concurrent requests share the native quit decision, cancellation does not arm relaunch, and approval schedules relaunch through the existing orderly quit path

#### Scenario: Unmanaged or failed recovery
- **WHEN** the launcher cannot replace its process or recovery reaches its configured deadline
- **THEN** the dialog remains retryable and provides manual recovery guidance
