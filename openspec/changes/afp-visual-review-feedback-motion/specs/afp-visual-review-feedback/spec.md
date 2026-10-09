## ADDED Requirements

### Requirement: Saved screening facts
AFP SHALL show persisted screening counts by category and distinguish successful pixel decisions, visual rejections, retention, targets and request failures. Raw provider errors and media URLs MUST NOT appear in summaries.

#### Scenario: Mixed outcomes
- **WHEN** a saved run has kept, rejected and request-failed decisions
- **THEN** request failures are separate from successful pixel checks and rejections, and fixed rejection types are available on rejected image previews

### Requirement: Owned background feedback
AFP SHALL display a launch acknowledgement and real progress only from the owning Session, Turn and callId. A launch handle MUST NOT be presented as completed visual screening or a saved final selection.

#### Scenario: Disconnect and closure
- **WHEN** polling disconnects or the owning Turn closes
- **THEN** the output row explains unavailable live progress, preserves saved facts, stops polling on closure and does not infer completion

### Requirement: Inline process disclosure
AFP SHALL present visual feedback as a collapsed process row matching reasoning disclosures, without a card background or border. The summary MUST retain real preview or decision counts and separate request failures in both collapsed and expanded headers. Expanded content SHALL show two independent image lists for passed and not-passed outcomes without repeating those counts; a live row MAY add one animated stage line.

#### Scenario: Reading progress without opening details
- **WHEN** a reader views a collapsed visual feedback row
- **THEN** real available counts remain visible inline, and opening or closing the row uses the shared disclosure animation

#### Scenario: One category and partial results
- **WHEN** one category has saved results below its target and some request failures
- **THEN** the heading includes the category, the header retains decision, kept and request-failure counts, its hint retains category targets and saved status, passed and not-passed images have independent disclosures, and rejection reasons are available per image without another text-details panel

#### Scenario: Failed or preparing report
- **WHEN** a saved report is preparing, running, failed or cancelled
- **THEN** that status remains in the header summary rather than being hidden in check details

### Requirement: Observable setup and image checks
AFP SHALL persist preparation stages before screening, emit setup output, bound each preparation stage by the configured request timeout and count downloaded previews separately from successful visual decisions. Same-process concurrent starts of the same run MUST be refused before creating another job.

#### Scenario: Slow connection
- **WHEN** connection setup has started but no pictures have been read
- **THEN** the saved report shows running with the connection stage and zero pixel checks, and timeout produces a saved failed stage

#### Scenario: Duplicate resume
- **WHEN** a run already has a live task in the same Host
- **THEN** resume is rejected without another admitted job or a change to that run's status

### Requirement: Recorded image previews
AFP SHALL provide separate passed and not-passed image disclosures, both collapsed by default with an image icon, and show at most five thumbnails at once in each horizontal list; all additional images SHALL remain available by scrolling. Only visible previews SHALL load. Live image identities MUST originate from successful preview reads; historical identities MUST come from the original authenticated tool result. Verdicts MUST come from saved per-image outcomes; request failures and pending previews MUST NOT be classified as not passed. UI-only identities and outcomes MUST remain outside model-visible text. Narrow layouts SHALL reduce visible images to fit their available width and retain the complete header summary in a hint.

#### Scenario: Browsing viewed images
- **WHEN** the reader expands feedback containing recorded image identities
- **THEN** both lists remain collapsed until explicitly opened, opening or closing either list leaves the other unchanged, the initial desktop viewport shows at most five thumbnails, horizontal scrolling reveals every additional image, and selecting any image opens the exact same preview modal as the AFP Workbench

#### Scenario: Historical identity unavailable
- **WHEN** an original tool result lacks image identities or verdicts, or cannot be read
- **THEN** the row explains that condition without substituting the current run report, and stale responses from a previous Session are ignored

### Requirement: Expanded phase activity
AFP SHALL combine the live stage and any positive pending-image count in one expanded TextShimmer line, without another pending notice below the lists. It SHALL animate only while the owning task is running, connected and expanded. The header SHALL shimmer only while collapsed and running; expanding SHALL stop header activity so only the stage line shimmers. Completed, failed, stopped, disconnected and closed-Turn states SHALL stop activity; reduced-motion preference SHALL suppress its animation.

#### Scenario: Opening and stopping a task
- **WHEN** the reader expands a live visual task, then its task stops or connection becomes unavailable
- **THEN** the expanded stage uses the same animation as the collapsed process row while running, keeps readable static text after stopping, and does not repeat phase text in the expanded header

### Requirement: Repeated report reads
AFP SHALL consolidate identical successful report reads within one Turn while retaining original inspector records and distinct changed results.

#### Scenario: Unchanged report
- **WHEN** the same run report is read repeatedly with identical counts and status
- **THEN** one summary remains visible and all original tool records remain in the inspector

### Requirement: Native task planning without duplicate capsule
AFP SHALL retain inline conversation feedback without registering a separate composer progress capsule. Its DSH Skills SHALL instruct checklist creation before AFP execution and SHALL reserve persistent goals for genuinely large resource objectives requiring multiple continuation rounds.

#### Scenario: Ordinary selection request
- **WHEN** the user requests ten visually accepted photos
- **THEN** the Skill instructs todo_write before AFP operations and does not create a goal
- **AND** report and selection results determine task completion, while the native checklist and inline feedback remain available

#### Scenario: Task state icons and goal surface
- **WHEN** a recorded task list is expanded
- **THEN** task status determines the shared rounded-square, progress-arc or check SVG, while removed tasks retain removal presentation
- **WHEN** a queue and a goal are both present
- **THEN** they share one solid hero-style header, with the queue above the goal and a 10px composer overlap
- **AND** the queue body scrolls independently, all goal actions remain available, and an empty shared slot occupies no height

#### Scenario: Animated queue disclosure
- **WHEN** the reader opens or closes a multi-message queue
- **THEN** height, opacity and the chevron transition smoothly in both directions
- **AND** closing immediately removes hidden actions from focus and accessibility navigation, rapid reversal preserves the body, and reduced motion disables transitions

#### Scenario: Stable checklist width and ongoing task feedback
- **WHEN** a checklist is displayed, hovered, focused, or expanded
- **THEN** it retains the existing dock width within the available composer width
- **WHEN** a task row displays the in-progress state
- **THEN** its icon uses a rotating arc on a circular track
- **AND** reduced motion keeps the progress arc static
