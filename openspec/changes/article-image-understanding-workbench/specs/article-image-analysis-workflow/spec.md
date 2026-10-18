## ADDED Requirements

### Requirement: Automatically analyze a qualified capture

After the user starts single or batch article processing, the Host SHALL queue analysis when capture quality passes or the editor explicitly chooses review-and-analyze for an eligible source review. Opening or saving a review without that action SHALL NOT start model execution. Import alone SHALL remain read-only with respect to model execution, and an unchanged valid plan SHALL be reused unless the user requests reprocessing. The workflow SHALL NOT depend on copying instructions into a separate chat.

#### Scenario: Finish a qualified capture
- **WHEN** article processing produces a qualified source snapshot and required model capabilities are ready
- **THEN** the Host advances through understanding, planning and checking to a saved plan awaiting human review

#### Scenario: Import the same source again
- **WHEN** the user reimports a sheet with unchanged analysis-relevant content
- **THEN** stored articles and plans remain available and no model request is started by the import

### Requirement: Own analysis through an isolated DSH session

Each article analysis SHALL use a plugin-owned dedicated DSH session with explicitly resolved model configuration, bounded resources and a restricted tool set. It SHALL record durable input receipt and task-bound stage submissions. It SHALL NOT grant the analysis Agent approval, arbitrary shell/file mutation, plugin management or image-generation capabilities.

#### Scenario: Submit a stage result
- **WHEN** the dedicated session submits a result matching the active attempt and input snapshot
- **THEN** the Host validates and commits it as that stage's result before advancing

#### Scenario: Agent becomes idle without submission
- **WHEN** a session stops, becomes idle or is cancelled without a validated stage submission
- **THEN** the Host does not classify the stage as completed

### Requirement: Persist genuine workflow progress

The Host SHALL persist run identity, attempt, stage, status, committed checkpoints, real counters, timestamps and safe errors. The workbench SHALL display stage progress and actual completed counts and SHALL NOT invent percentages for semantic understanding. Job handles and transient progress SHALL NOT be the sole recovery record.

#### Scenario: Observe a model request in progress
- **WHEN** a model is generating an understanding result without measurable subtask completion
- **THEN** the page shows the current stage and indeterminate activity rather than a fabricated completion percentage

#### Scenario: Reopen the workbench
- **WHEN** a user leaves and reopens the page while processing continues
- **THEN** the page recovers current stage, committed counts and results from Host records without starting another task

### Requirement: Reject concurrent and stale task writes

The system SHALL allow at most one effective write task per article across participating processes. Every stage commit SHALL match the active attempt, source/input identity and expected revision. Reprocessing or manual changes SHALL invalidate old task authority, and late responses SHALL NOT replace newer content or plans.

#### Scenario: Start twice
- **WHEN** two callers concurrently request processing for one article
- **THEN** only one effective run is admitted and the other request returns the active run or an explicit busy result

#### Scenario: Late response after source replacement
- **WHEN** a model result arrives after its source was recaptured or manually changed
- **THEN** the result is rejected as stale without changing the current article or plan

### Requirement: Cancel and drain owned work

Page closure SHALL detach observation only. An explicit stop, analysis-feature disable or plugin unload SHALL cancel owned work and await browser pages, model requests, file commits and subscriptions reaching quiescence. Cancellation SHALL prevent subsequent stages and late state mutations.

#### Scenario: Stop while a model call is active
- **WHEN** the user stops the current run
- **THEN** cancellation reaches the active request, the run settles as cancelled, and no later stage or plan commit is accepted from that attempt

#### Scenario: Unload during browser extraction
- **WHEN** the plugin unloads while extraction is active
- **THEN** browser resources close and owned asynchronous work settles before unload completes

### Requirement: Resume interrupted work explicitly

After Host loss, unfinished runs SHALL be reported as interrupted without automatic upstream replay. Explicit recovery SHALL preserve frozen input and reuse validated checkpoints while marking uncommitted or uncertain stages for another attempt. The system SHALL disclose that replaying an uncertain model request can consume additional model quota.

#### Scenario: Restart after a committed understanding stage
- **WHEN** the Host restarts after understanding was committed but before planning completed
- **THEN** the run is interrupted until the user resumes and recovery can reuse the committed understanding for the same frozen input

#### Scenario: Request outcome is uncertain
- **WHEN** the connection fails before a model result is durably submitted
- **THEN** the run records uncertainty and requires explicit recovery instead of silently repeating requests

### Requirement: Report missing prerequisites before dependent work

The system SHALL validate configured browser availability, model selection, required visual capability, rule resources and deployment limits at the earliest resolvable point. Missing prerequisites SHALL produce actionable readiness or waiting-config states without silently reducing capture or analysis guarantees.

#### Scenario: Browser or model is unavailable
- **WHEN** a required browser executable or configured analysis model cannot be used
- **THEN** the task identifies the missing prerequisite and does not fabricate capture or analysis success
