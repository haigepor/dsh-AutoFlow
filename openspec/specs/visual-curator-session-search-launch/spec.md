# visual-curator-session-search-launch Specification

## Purpose

Define profile-based image search with useful defaults, frozen reference materials, a new native Workspace Session, recoverable prompt admission, scoped original delivery and linked cancellation.

## Requirements
### Requirement: The search launch form has useful defaults

The system SHALL show a compact launch form for the profile-search entry with a native Workspace choice, editable prefilled brief, bounded target count and original output by default. Usage fields SHALL appear only when sized output is selected. Preparation SHALL NOT require a second confirmation screen or a paid model request.

#### Scenario: Start with defaults
- **WHEN** a current profile and a valid Workspace are available
- **THEN** the user can choose the Workspace and start with the prefilled brief, quantity and original output

#### Scenario: No Workspace is available
- **WHEN** there is no valid native Workspace to select
- **THEN** the form explains the missing Workspace and cannot silently use an arbitrary process directory

#### Scenario: Choose sized output
- **WHEN** the user selects sized output
- **THEN** the form exposes an existing usage preset or its size configuration and retains the original crop entry's behavior

### Requirement: Launch materials represent the selected profile

The system SHALL freeze the selected profile identity, content digest, enabled rules, group conditions, task parameters and budgets. A package for that exact profile SHALL be reused or generated automatically and attached as a native file. Unselected rules and historical narrative SHALL NOT override active rules. Reference data SHALL NOT become installed instructions or human confirmations.

#### Scenario: No matching package exists
- **WHEN** a fresh profile has no completed matching reference package
- **THEN** launch prepares that package automatically without requiring a separate export action

#### Scenario: Profile changes after launch
- **WHEN** the collection adopts another profile after launch is accepted
- **THEN** the existing task continues using its original frozen profile and attachment

#### Scenario: Stale or unavailable evidence
- **WHEN** the selected profile is stale, lacks active rules or contains unauthorized references
- **THEN** launch reports the actionable failure before creating a new execution Session

### Requirement: Start creates and submits a native Workspace Session

Each distinct owner-authorized launch SHALL create a new ordinary Session in the selected native Workspace and submit the initial task message with the reference package. The system SHALL open the returned Session and SHALL NOT overwrite an existing draft, merely prepare an unsent prompt, change global model defaults or raise permissions.

#### Scenario: Successful native launch
- **WHEN** preparation succeeds and the user starts
- **THEN** the selected Workspace contains a new named Session with the dataset attachment and accepted initial task message

#### Scenario: Existing blank conversation
- **WHEN** the Workspace already contains an unsent blank conversation
- **THEN** its draft remains unchanged and the explicit launch receives its own Session

### Requirement: Launch recovery preserves operation identity

Launch SHALL be held by the Host with durable stage, frozen inputs, Session identity and prompt request identity. Closing the dialog or disconnecting SHALL NOT cancel accepted preparation. Retrying the same operation SHALL recover its Session and prompt, and incompatible input with the same identity SHALL be rejected.

#### Scenario: Lost creation acknowledgement
- **WHEN** Session creation succeeded but the browser lost the acknowledgement
- **THEN** recovery returns or continues the same Session without creating a second one

#### Scenario: Accepted prompt acknowledgement is lost
- **WHEN** the initial prompt is already queued or logged and its acknowledgement is lost
- **THEN** retry checks or resubmits the same request identity and accepts it once

#### Scenario: Attachment receipt expired after restart
- **WHEN** the Session exists but its staged attachment receipt is unavailable
- **THEN** recovery restages the frozen package and checks original prompt admission before submitting

#### Scenario: Partial failure after Session creation
- **WHEN** attachment preparation or prompt admission fails after creation
- **THEN** the same Session and user inputs remain recoverable with an explicit continue action

### Requirement: Original search preserves original deliverables

An explicit original-output search SHALL NOT require a usage revision or invoke crop processing. It SHALL perform deduplication and actual-pixel qualification before selecting results. A downloadable original SHALL contain verified source-original bytes, not normalized analysis pixels. Sized and legacy searches SHALL retain their fixed usage and crop checks.

#### Scenario: Qualified original
- **WHEN** a distinct candidate passes the required visual checks in original mode
- **THEN** the result is selected without a crop and its authorized original download matches the saved original digest

#### Scenario: Unknown or failed visual evidence
- **WHEN** source or final evidence is unknown or technically failed
- **THEN** the candidate is not counted as qualified simply to reach the target

#### Scenario: Legacy or sized task
- **WHEN** an existing caller supplies a usage revision without the new original selection
- **THEN** the existing exact-size crop and final review behavior is preserved

### Requirement: Delivery and task context remain scoped

Workspace materialization SHALL be confined to the selected Workspace's task directory, preserve existing unrelated files and verify source bytes. Native Session and plugin resource ownership SHALL remain enforced. Launch authorization SHALL cover only its own task results and SHALL NOT authorize unrelated private references or arbitrary file writes.

#### Scenario: Foreign resource
- **WHEN** another Session requests a private result or private launch materials
- **THEN** the operation is rejected without exposing download bytes or private paths

#### Scenario: Unsafe or replaced output directory
- **WHEN** the target directory no longer belongs to the selected Workspace or would overwrite an unrelated file
- **THEN** delivery fails visibly and leaves the unrelated files unchanged

### Requirement: Conversation and background task states remain truthful

The system SHALL associate actual search Runs with the execution Session, expose real progress and saved results, and distinguish prompt acceptance from active image retrieval and completed qualification. Stop-this-search SHALL cancel the associated Session execution and visual Runs while retaining committed results. Ordinary close and navigation SHALL NOT stop them.

#### Scenario: Agent is planning
- **WHEN** the initial message is accepted but no search Run exists
- **THEN** the UI reports Session acceptance or planning without fabricated image counters

#### Scenario: Stop running search
- **WHEN** the user stops the linked search
- **THEN** native execution and associated background Runs receive cancellation and completed results remain available

### Requirement: Native integration is verifiable without paid services

The implementation SHALL include owner-local expected output and keyless Host, Client and Loader composition coverage for launch, recovery, attachments, ownership, original/sized output and disposal. The simple dialog and progress feedback SHALL reuse native controls and work in light, dark and narrow layouts with localized copy and keyboard access.

#### Scenario: Keyless native composition
- **WHEN** the shipped integration is loaded with deterministic external model and image adapters
- **THEN** tests observe the real Workspace Session, logged prompt attachment, linked Run and reversible lifecycle without a paid service

#### Scenario: Narrow screen
- **WHEN** the form is used at narrow width or with reduced motion
- **THEN** required controls, failure feedback, close and start actions remain accessible without horizontal overflow
