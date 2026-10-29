## ADDED Requirements

### Requirement: Candidate failures retain their actual stage

The system SHALL distinguish unavailable source originals, download/import failures, technical review failures, uncertain review results and visual rejections. Diagnostics MUST contain a candidate identity and safe stage/code without credentials or ephemeral media URLs. Known restricted originals SHALL NOT trigger redundant lookup or use preview bytes as originals.

#### Scenario: Restricted original
- **WHEN** the source explicitly declares an original unavailable
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

Localized compact tool cards SHALL show operation, actual status/stage, real counts, result previews and a scoped task action. Raw tool material SHALL remain available in details. Live data MUST come from authorized run reads, without starting tasks or trusting model narration. Observations MUST be shared per Session/Run, stop when no longer viewed, stop polling terminal runs and ignore obsolete responses after disconnect or Session changes.

#### Scenario: Switch Session during an outstanding read
- **WHEN** the old Session's response arrives after a switch
- **THEN** it cannot replace the new Session's feedback or resources

#### Scenario: Disconnect or historical replay
- **WHEN** the transport disconnects or a historical card is opened
- **THEN** committed data remains distinguishable from live freshness, and reading cannot restart search or invoke a paid provider

### Requirement: Workbench feedback is readable and actionable

Task details SHALL present title, actual state/stage, whole-run metrics, lifecycle controls, categorized results, safe diagnostics and filter-specific empty states using existing native components and localized copy. Primary actions and errors MUST remain usable at 390 CSS px in light and dark themes with keyboard access.

#### Scenario: No selected results but review or failures exist
- **WHEN** final selected count is zero and other categories contain candidates
- **THEN** the interface reports those categories and their counts without implying the search found nothing
