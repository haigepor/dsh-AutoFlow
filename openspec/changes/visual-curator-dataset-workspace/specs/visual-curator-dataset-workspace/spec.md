## ADDED Requirements

### Requirement: Export progress reflects completed work

The system SHALL report persisted export phases and actual completed/total units without deriving progress from elapsed time. Unknown totals and request acknowledgement SHALL use indeterminate progress. Existing format-two files and checksums SHALL retain their semantics.

#### Scenario: Reference verification advances
- **WHEN** a reference is verified during an export
- **THEN** the owning run reports the corresponding verification count and the work is not repeated for presentation

#### Scenario: Final output is available
- **WHEN** the package is committed and export completion is confirmed
- **THEN** the task exposes its artifact identity and authorized download path

### Requirement: Closing the dialog preserves task ownership

The workbench SHALL retain submission identity and background export state independently of the profile dialog. Closing, reopening, or switching views SHALL NOT start another export or cancel the running job. Unknown acknowledgements SHALL retain the same operation identity for explicit retry.

#### Scenario: Close before acknowledgement
- **WHEN** the user closes the profile dialog while export-start is pending
- **THEN** the request remains owned by the workbench and its acknowledged task appears in the background card

#### Scenario: Reopen a running task
- **WHEN** the user opens the progress view for the existing export
- **THEN** the dialog observes the same run and displays its current reported progress

### Requirement: Generation feedback uses shared presentation

The profile dialog SHALL display a translucent black content-area mask, existing loading artwork, stage and progress during generation while keeping close controls usable. The reference view SHALL present background export status through the same card presentation used for image referencing. The datasets view SHALL present the task in its list row.

#### Scenario: Generation blocks editing
- **WHEN** a package is being generated
- **THEN** the profile content cannot be edited and the title and close controls remain accessible

#### Scenario: Narrow viewport
- **WHEN** the viewport narrows or reduced motion is enabled
- **THEN** progress and actions remain reachable without horizontal overflow and motion follows the existing reduced-motion policy

### Requirement: Dataset lists are scoped and lightweight

The system SHALL provide a third workbench datasets view with current-collection paging, status/text filtering and creation-time ordering. Each generated run and its artifact SHALL appear as one entry. Reads SHALL enforce profile and Session ownership, and progress polling SHALL NOT refetch image collections or raw file contents.

#### Scenario: Completed task joins its artifact
- **WHEN** an export run records its profileExport result
- **THEN** the existing list entry gains completed metadata and download actions without a duplicate artifact row

#### Scenario: Foreign scope
- **WHEN** a caller requests another owner's or Session's dataset
- **THEN** the request is rejected without returning its metadata or download reference

### Requirement: Dataset details represent the frozen package

The detail view SHALL read the selected export snapshot and display overview, selected rules/groups, sample observations and file checksums. It SHALL distinguish model suggestions from human reference feedback, unavailable measurements from reported values, and remote image references from embedded bytes. File previews SHALL be bounded and full downloads SHALL retain existing authorization.

#### Scenario: Current profile changes
- **WHEN** a new profile revision is adopted after a dataset was generated
- **THEN** viewing the older dataset continues to show its original rules, samples and source profile identity

#### Scenario: File preview is truncated
- **WHEN** a file exceeds the configured preview limit
- **THEN** the detail reports truncation and retains the authorized full-package download action

### Requirement: Dataset table follows model settings presentation

The dataset table SHALL use the model settings directory's theme surfaces, lightweight headings, identity hierarchy, row interaction feedback and compact actions. Search and status controls SHALL stay on the same horizontal line, including narrow layouts, without overflowing the workspace.

#### Scenario: Search and status share a row
- **WHEN** the datasets page is displayed at desktop or narrow width
- **THEN** search and status controls share a vertical center, with the status selector retaining a bounded width

### Requirement: Read and generation failures remain visible

The system SHALL retain existing results when refresh fails, expose localized actionable failures, and clear private state on scope or authorization changes. Retrying an unknown submission SHALL NOT allocate a second operation identity.

#### Scenario: Progress read fails temporarily
- **WHEN** refreshing an already visible export task fails
- **THEN** the last known task remains visible with a retryable read error and is not presented as completed
