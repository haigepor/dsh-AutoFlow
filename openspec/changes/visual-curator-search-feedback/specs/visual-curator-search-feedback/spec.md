## ADDED Requirements

### Requirement: New search launches require an explicit eligible dataset

The search-launch form SHALL require one completed reference package matching the selected collection and exact model profile. Eligibility SHALL be applied before paging and SHALL exclude packages private to another Session. The selector SHALL expose package version, reference/rule counts, creation time, details and a path to generation while retaining the draft. Missing selection or failed loading SHALL disable new admission. The Host SHALL validate ownership, profile identity, necessary files, checksums and the packaged profile digest before creating a conversation, and SHALL bind the chosen export identity to the durable request without generating or substituting another package. Existing admitted launches SHALL retain their original request digest, package binding and recoverable preparation.

#### Scenario: No eligible dataset
- **WHEN** no completed reusable package matches the current profile
- **THEN** new launch is disabled and the user can visit dataset generation without losing the form

#### Scenario: Select and admit one package
- **WHEN** a selected package passes owner, profile and file validation
- **THEN** the original export identity is stored before Session creation and reused by retry and recovery

#### Scenario: Invalid selection or legacy recovery
- **WHEN** a new launch lacks a valid package or an earlier admitted launch is retried
- **THEN** the new launch is rejected before Session creation, while the earlier launch replays its original parameters without rewriting saved data

### Requirement: Preview searches do not require original files

New native launches SHALL default to explicit preview output while preserving original and usage choices and previously admitted inputs. Preview searches SHALL require the supported Unsplash source, use validated public regular-preview URLs, rotate one candidate per query and retain stable IDs rather than temporary media URLs for resume. The Agent SHALL propose subject-and-style queries from the selected package's enabled rules and alternative groups within frozen search budgets. Review SHALL include source and final rules without downloading originals, cropping or creating an output directory. UI and tool projections SHALL distinguish preview matches and source-link deduplication from original verification and pixel deduplication.

#### Scenario: Original unavailable but preview is public
- **WHEN** a preview search recalls an item whose original is restricted and public preview is available
- **THEN** it may review the validated preview without claiming original access or byte-export permission

#### Scenario: One query returns unrelated subjects
- **WHEN** multiple queries have candidates and the first query's candidate fails review
- **THEN** the next query gets a candidate turn without exhausting the first query's queue

#### Scenario: Unknown evidence cannot meet the threshold
- **WHEN** satisfying every unknown rule still cannot reach the frozen style-match ratio
- **THEN** that rule group is not matched rather than pending review
- **AND** all-unknown evidence remains unresolved

### Requirement: Candidate failures retain their actual stage

The system SHALL distinguish unavailable source originals, download/import failures, technical review failures, uncertain review results and visual rejections. Diagnostics MUST contain a candidate identity and safe stage/code without credentials or ephemeral media URLs. Known restricted originals SHALL NOT trigger redundant lookup or use preview bytes as originals.

#### Scenario: Restricted original
- **WHEN** an original or usage search receives an explicitly unavailable original
- **THEN** the candidate is reported as unavailable without download, review, redundant lookup or visual rejection

#### Scenario: Download or review failure
- **WHEN** download, import or model review fails
- **THEN** the saved report identifies the failed stage and excludes the candidate from final qualification

### Requirement: Saved result categories remain truthful

Run summaries SHALL derive final selections, pending review, visual rejection, technical failures and in-progress images from committed records. Imported candidates SHALL be visible before assessments complete. Pagination and filters MUST retain whole-run counts; unknown or failed final assessments MUST NOT count as qualified.

#### Scenario: Source pass followed by uncertain final assessment
- **WHEN** source screening passes but final review is uncertain
- **THEN** the image appears under pending review and final qualified count remains unchanged

#### Scenario: Assessment not yet committed
- **WHEN** an image has been imported while review is running
- **THEN** it appears as processing without an invented verdict

### Requirement: Conversation feedback follows authorized durable runs

Each conversation SHALL render one localized task card in its upper-right body gutter below the native checklist, outside tool-process disclosures. Both entries SHALL share an ordered vertical stack so expanding the checklist moves the task card down without fixed offsets. The card SHALL follow the checklist's minimum gutter-width visibility rule. Multiple tasks SHALL switch within this card without mixing Run identities or counts. The compact view SHALL show actual status/stage, real counts and a scoped task action; previews SHALL expand within a bounded height using native components and theme tokens. Tool calls SHALL retain compact localized receipts and original call inspection without duplicate task cards. Live data MUST come from authorized run reads without starting tasks or trusting model narration. Observations MUST be shared per Session/Run, stop when no longer viewed, stop polling terminal Runs and ignore obsolete responses after disconnect or Session changes. Lightweight Session discovery SHALL restore saved tasks without mounted tool views and detect new or externally resumed tasks while the conversation is viewed.

The card SHALL provide an authorized background-stop action. It SHALL stop the owning launch and associated Runs when a launch exists, otherwise cancel only the selected Run. Conversation stop SHALL remain distinguishable from background cancellation. Detailed and catalogued states SHALL use saved revisions so an older running response cannot replace a confirmed terminal state. Cancelling SHALL remain visible until the saved Run confirms completion or cancellation.

#### Scenario: Repeated progress reads inside a collapsed process
- **WHEN** a task has multiple start or progress receipts and its tool process is collapsed
- **THEN** exactly one task card remains outside the process and follows the selected saved Run

#### Scenario: Multiple tasks and compact results
- **WHEN** the reader switches between saved searches and crops or expands their results
- **THEN** only the selected Run supplies counts and previews, the input remains accessible, and Escape collapses results with focus returned to the disclosure

#### Scenario: Resize the task card
- **WHEN** the reader drags the card's left edge or uses its focused separator with arrow keys, Home or End
- **THEN** the right edge remains anchored, width stays within 280–640 CSS px and the current body bounds, and the checklist retains its own width
- **AND** pointer cancellation restores the previous width, double-click restores the default, and switching tasks retains the current card width without mixing Session state

#### Scenario: Expanded task card fills the remaining body height
- **WHEN** the task card expands below the native checklist
- **THEN** it fills the remaining conversation-body height and only overflowing result content scrolls
- **AND** its header and controls stay visible, checklist expansion reallocates height, collapsing restores compact height, and narrow gutters keep their existing visibility rule

#### Scenario: Switch Session during an outstanding read
- **WHEN** the old Session's response arrives after a switch
- **THEN** it cannot replace the new Session's feedback or resources

#### Scenario: Disconnect or historical replay
- **WHEN** the transport disconnects or a historical card is opened
- **THEN** committed data remains distinguishable from live freshness, and reading cannot restart search or invoke a paid provider

### Requirement: Workbench feedback is readable and actionable

The Find and crop tab SHALL initially show all saved matched results in the current collection, grouped by their original search or crop Run. A human-only read MAY aggregate that collection's authorized conversation results without changing Agent or execution-control permissions. Images MUST retain original Session resource authorization. Batch and image pagination SHALL be independent; changing collections SHALL invalidate old reads. Missing Sessions SHALL remain visible as unavailable batches. Single-batch filtering, preview reading and the original Run's controls and diagnostics SHALL remain available.

Task details SHALL present title, actual state/stage, whole-run metrics, lifecycle controls, categorized results, safe diagnostics and filter-specific empty states using existing native components and localized copy. Primary actions and errors MUST remain usable at 390 CSS px in light and dark themes with keyboard access.

The task toolbar SHALL show identity, actual state, one target-progress indicator and lifecycle actions above result filters. A native Task details menu SHALL retain the full brief, secondary counts, stopping outcome, delivery and diagnostics. Structured diagnostics SHALL suppress duplicate legacy warnings, and terminal states SHALL omit stale processing stages. All results, final selections, pending review and the active filter SHALL remain available; other zero-count categories MAY be omitted. Result tiles SHALL stay compact at approximately 200–224 CSS px in normal-width panes, without enlarging sparse results. Each tile SHALL retain a full-proportion preview, state, dimensions, short review summary and details. Preview output SHALL provide a public preview action without crop or original-delivery actions; other outputs retain crop actions. Complete notes remain available in the native details modal.

The workbench launch summary SHALL appear as a compact trigger beside the collection selector in the top header, without a separate content row. Its native menu SHALL expose the localized task state, real counts, delivery path and existing actions; the launch dialog SHALL retain its complete summary. Before execution creates a Run, it SHALL display the requested target without implying qualified results. A stopped launch SHALL use a neutral status, distinct from incomplete results or failures. Narrow panes SHALL keep the trigger beside the selector while allowing the existing header navigation to wrap.

#### Scenario: No selected results but review or failures exist
- **WHEN** final selected count is zero and other categories contain candidates
- **THEN** the interface reports those categories and their counts without implying the search found nothing

#### Scenario: Inspect a stopped launch
- **WHEN** a stopped launch retains a Run and its qualified count
- **THEN** the summary shows a neutral stopped label, actual qualified/target counts and the existing conversation action in separate groups
