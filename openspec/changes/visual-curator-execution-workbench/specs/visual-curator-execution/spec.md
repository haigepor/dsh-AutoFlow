## ADDED Requirements

### Requirement: Read-only task preparation
The system SHALL expose paginated latest usage revisions and shared task preparation to the authenticated workbench and Agent readers without starting jobs or paid requests.

#### Scenario: Missing usage
- **WHEN** an authorized caller prepares a task without a usage revision
- **THEN** the response identifies the missing field and available usages, source and budget limits without writing records

#### Scenario: Changed preparation
- **WHEN** rules, usage, configuration or normalized inputs change after preparation
- **THEN** starting with the previous preparation digest fails before job admission

#### Scenario: Idempotent accepted start
- **WHEN** an accepted operation is retried after a response was lost
- **THEN** the original authorized Run is returned without another job

### Requirement: Usage and task workbench
The workbench SHALL reuse its current visual system to create usage revisions inline and start search with automatic crop through a two-step task dialog.

#### Scenario: First task
- **WHEN** a user with a complete profile saves an exact-ratio usage, prepares and starts a search
- **THEN** the task detail opens and shows bounded progress without requesting manually invented identifiers

#### Scenario: Concurrent usage editing
- **WHEN** another editor has saved a newer current usage revision
- **THEN** saving with an old expectedCurrentRevisionId preserves the form and rejects the stale write

### Requirement: Session-authorized task navigation
The system SHALL open Agent tasks using their original Session grant, retain grants only in memory and clear private view state on scope changes.

#### Scenario: Open Agent task
- **WHEN** the user activates the tool card task action
- **THEN** the workbench obtains an authenticated Session grant before requesting that task and its pixels

#### Scenario: Invalid or expired scope
- **WHEN** the Session is unavailable or its grant is invalid
- **THEN** private pixels are not displayed and the workbench presents a recoverable access state

### Requirement: Explicit final selections
The system SHALL expose actual selection membership separately from source/final assessments, return authorized full counts and render the real stopping outcome.

#### Scenario: One final image and a passing source
- **WHEN** the run has one selection and a passing source assessment
- **THEN** the final-results view contains only the selected derivative and all-candidates retains the source

#### Scenario: Partial completion
- **WHEN** the task completes because its budget or source was exhausted
- **THEN** the page displays the actual selected/target counts and stopping reason rather than treating completion as target achievement

### Requirement: Fixed current rule instructions
New model-profile tasks SHALL compile execution instructions from current enabled rules and applicable groups, without executing stale model-summary instructions or adjusted-profile search hints.

#### Scenario: Edited color preference
- **WHEN** a green preference is changed to red and the task is prepared
- **THEN** the actual review instruction contains the red rule and does not execute the old green matching prompt

### Requirement: Versioned final style matching
New model-profile tasks SHALL freeze their matching policy, check actual final crop pixels, apply shared preferences and any one applicable alternative group, and keep unknown distinct from rejection.

#### Scenario: Every preference violated
- **WHEN** final visual preferences are all violated even though task relevance is relevant and geometry is legal
- **THEN** no automatic selection is created

#### Scenario: Alternative group
- **WHEN** shared preferences and one applicable group satisfy the configured ratio
- **THEN** unrelated groups do not veto the result and the matched group is saved

#### Scenario: Historical resume
- **WHEN** a task without the new execution policy is resumed
- **THEN** it uses its existing fixed behavior without record rewriting or new defaults

### Requirement: Native responsive interaction
The implementation SHALL preserve existing components, theme tokens and locale-owned copy and keep primary actions accessible at 390 CSS pixels.

#### Scenario: Narrow task dialog
- **WHEN** the dialog is used at 390 pixels
- **THEN** content scrolls inside its body, the actions remain reachable, and closing returns focus to the trigger
