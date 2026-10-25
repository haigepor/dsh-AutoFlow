## ADDED Requirements

### Requirement: Read-only saved model inputs
The process dialog SHALL show actual saved system instructions, user message text and ordered image references for each analysis or summary request. Full input SHALL load on demand through the authorized run, independently of progress polling. New response messages SHALL identify their request record explicitly, including retries. Historical messages without that identity SHALL remain readable beside separately listed saved requests; missing historical inputs SHALL be labeled unavailable without rebuilding them from current configuration or sending model requests.

#### Scenario: Inspect one model request
- **WHEN** a saved request enters the reading viewport and the owner opens Input details
- **THEN** its original instructions, exact user text and image order are available with the existing project image preview, without exposing authentication headers or embedded image bytes

#### Scenario: Read cancelled or retried work
- **WHEN** a request is cancelled or retried
- **THEN** each saved attempt retains its own identity and input, while reserved or unknown outcomes do not claim successful provider receipt

#### Scenario: Read historical output without a request link
- **WHEN** a saved response has no explicit request-record identity
- **THEN** the UI keeps that response and lists available requests separately rather than inferring a pair from position

#### Scenario: Deny another run's request
- **WHEN** an input read names a request outside the authorized run
- **THEN** the Host rejects the read and returns no prompt or image resource

### Requirement: Conversation reading layout
The process dialog SHALL arrange saved user input on the right and actual model output on the left using existing chat theme tokens and image previews. Long input SHALL expand in place. System instructions, complete user text and image identities SHALL remain accessible through one Input details action. Reasoning and raw responses SHALL be collapsed by default; model settings SHALL appear in activity. No composer or new Session SHALL be created.

#### Scenario: Read on a narrow screen
- **WHEN** the owner reads the conversation at a 390 CSS pixel viewport in dark mode
- **THEN** the message sides remain distinguishable, no horizontal overflow occurs, and closing Input details returns focus to its trigger before the parent dialog can close

### Requirement: Task controls and readable history
The workspace SHALL place the process entry beside the main analysis action, keep it usable during analysis, and disable it when no analysis exists. Task history SHALL show type, status and available committed counts in compact selectable rows, with actions and results adjacent to the selected task. Labels SHALL be localized. Selection, result ranking, pagination and collection isolation SHALL retain their existing semantics.

#### Scenario: Inspect a running task from the main actions
- **WHEN** a collection is analyzing
- **THEN** its process entry remains beside the analysis action and opens that collection's process without starting another task

#### Scenario: Inspect task history on a narrow screen
- **WHEN** task history is opened at a 390 CSS pixel viewport
- **THEN** task selection, status, results and actions remain usable without horizontal page overflow

### Requirement: A single reading pane in the process dialog
The opaque process dialog SHALL keep its title, compact status, counts, configuration and actions separate from one active reading pane. Model output and activity SHALL use keyboard-accessible tabs. Switching tabs SHALL preserve the output reading position. Unfinished terminal batches SHALL collapse by default while retaining expandable provider output; committed observations SHALL remain readable.

#### Scenario: Inspect a cancelled batch
- **WHEN** a cancelled task contains committed observations followed by an unfinished response
- **THEN** saved observations remain visible and the unfinished batch uses a compact expandable status row

#### Scenario: Switch between output and activity
- **WHEN** the reader switches from earlier model output to activity and back
- **THEN** the output returns to its previous reading position and live updates do not force a jump to the bottom

### Requirement: Analysis output reads as a conversation
The process dialog SHALL use an opaque theme surface, separate progress/configuration from the reading area, and present observations in two columns on wide views and one on narrow views. It SHALL place actual model messages above diagnostic activity, append a separate message per observation batch and summary, and preserve previous committed observations while later responses stream. Provider-returned reasoning SHALL be readable at conversation text size and expandable per message. Structured responses SHALL offer readable observations and summary content with raw text available separately. The feed SHALL follow new output only while the reader stays near its end; scrolling upward SHALL preserve the reader's position and offer an explicit return to the latest output. Process messages SHALL have bounded retained text and survive task checkpoints without a durable write for every token.

#### Scenario: Read earlier output during a later batch
- **WHEN** a later batch returns text while the reader has scrolled upward
- **THEN** earlier messages remain visible without forced scrolling, a latest-output action is available, and progress continues independently

#### Scenario: Close and reopen the model conversation
- **WHEN** the process dialog closes and reopens for the same task
- **THEN** retained batch messages and committed observations remain available and closing does not cancel the task

### Requirement: Collection-owned concurrent analyses
Analyses SHALL execute independently of navigation and dialogs. Different collections MAY analyze concurrently within configured capacity. One collection SHALL admit only one active analysis, including concurrent browser submissions. Excess analyses SHALL wait and remain cancellable.

#### Scenario: Switch while another collection analyzes
- **WHEN** collection A is analyzing and its owner selects collection B
- **THEN** A continues against its frozen inputs and B can start its own analysis without altering A

### Requirement: Explicit cancellation and system recovery
New analyses SHALL retain committed checkpoints across system interruption and automatically resume eligible work with the original RunSpec, owner and budget. User cancellation SHALL revoke recovery. Terminal states SHALL not regress when completion and cancellation race. Old cancelled tasks without recovery intent SHALL remain cancelled.

#### Scenario: System interruption after a committed batch
- **WHEN** the Host stops after one batch commits and starts again within the saved budget
- **THEN** the original analysis resumes under a new attempt without redoing that batch or applying the new default model settings

#### Scenario: Owner cancels an analysis
- **WHEN** the owner cancels an active or queued analysis
- **THEN** confirmed results remain readable and neither restart nor configuration save resumes the cancelled task

### Requirement: Frozen task configuration and responsive saves
New tasks SHALL default to high reasoning effort while preserving explicit provider defaults. Reading an older RunSpec SHALL preserve omitted reasoning parameters. Saving current vision defaults SHALL retain active tasks and provide independent loading feedback; success SHALL require durable configuration application but SHALL not require a complete workspace refresh.

#### Scenario: Save high while a task uses another effort
- **WHEN** the owner saves high while a task is running under its frozen settings
- **THEN** that task keeps those settings and completed images, subsequent tasks use high, and navigation remains available during saving

### Requirement: Truthful live analysis details
The Client SHALL show collection-owned progress and a dismissible process dialog with stages, committed image counts, request activity and bounded model output. Only actual upstream visible output SHALL be presented. Final structured output SHALL pass existing validation before observations count as committed. Details SHALL be scoped to the authorized run and retained across Client reconnection where recorded.

#### Scenario: Close a live process dialog
- **WHEN** its owner closes the dialog while the model is responding
- **THEN** the task continues, and reopening reads the same run's current process and committed results

#### Scenario: Provider returns JSON instead of a stream
- **WHEN** an authorized request returns a complete compatible JSON response
- **THEN** the Host validates that response and reports real stages without inventing streamed reasoning or sending a replacement request solely for display

### Requirement: Reuse the shared reasoning renderer
The process dialog SHALL render original model reasoning through the existing root-scoped conversation.chat.reasoning.content Factory. It SHALL pass the real streaming state and use the shared disclosure primitive without copying Markdown rendering or requiring a Session. Historical reasoning outside per-request messages SHALL use the same Factory.

#### Scenario: Read live reasoning
- **WHEN** the owner expands reasoning while an isolated analysis is running
- **THEN** the shared compact Markdown renderer displays the actual provider text, the shared running-title effect ends when reasoning ends, and keyboard expansion remains available

### Requirement: Image evidence and semantic output hierarchy
The process dialog SHALL align observations with the same imageVersionId from authorized saved input, use input-order numbers within each batch, and preserve original model text. It SHALL reuse the existing image preview and reasoning components. Style summaries SHALL distinguish supporting images from counterexamples using returned IDs. Missing previews SHALL remain explicit. Dimension icons SHALL inherit theme color and retain visible text labels.

#### Scenario: Inspect saved image observations
- **WHEN** an owner views a completed or cancelled task
- **THEN** saved observations remain visible, available thumbnails open the shared preview and return focus to their opener, and no model request is sent

#### Scenario: Inspect the actual input
- **WHEN** the owner opens input details
- **THEN** the task instruction and submitted images are shown first, with full user text, system text and ordered image identities available through keyboard-accessible tabs
