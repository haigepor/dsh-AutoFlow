## ADDED Requirements

### Requirement: Collection navigation and loading

The workbench SHALL provide an animated collapsible collection sidebar, meaningful unnamed-collection labels, upstream counts when available and skeletons for initial list and photo loading. Navigation SHALL preserve local photo selection and SHALL prevent late results from replacing newer selections.

#### Scenario: Collapse and switch collections

- **WHEN** a user collapses the sidebar or switches to another collection during a read
- **THEN** the gallery gains width, hidden navigation is not keyboard reachable and only the current collection's result is displayed

### Requirement: Independent gallery and detail scrolling

Desktop collection views SHALL keep the header and detail region separate from gallery scrolling, with a back-to-top control appearing after a meaningful scroll threshold. Narrow layouts SHALL remain usable within the workbench height.

#### Scenario: Browse a long collection

- **WHEN** the gallery scrolls beyond half of its visible height
- **THEN** the detail remains visible and the back-to-top control smoothly returns the gallery to its start, or immediately when reduced motion is enabled

### Requirement: Protected image preview

The workbench SHALL provide loading skeletons, retryable failures, clear selection feedback and an accessible project Modal for detail-image preview. Media MUST remain on the authenticated same-origin proxy, and invalid or non-allowlisted references MUST be refused without exposing tokens or signed URLs.

#### Scenario: Open a preview

- **WHEN** the user clicks an available image in the detail pane
- **THEN** a viewport-fitting preview opens, closes through Escape or close control, and restores focus

#### Scenario: Refused or unsupported preview

- **WHEN** media is unavailable, unsafe or uses an unconfigured CDN host
- **THEN** a bounded error and retry/configuration guidance is displayed, no unsupported image is rendered and no credentials are forwarded to CDN hosts

### Requirement: Resilient read-only collection projection

The photo browser SHALL exclude explicitly non-photo members, retain compatible legacy photo IDs and tolerate absent photo metadata without corrupting the collection. Existing write validation MUST remain unchanged.

#### Scenario: Mixed collection contents

- **WHEN** a selection contains photos, articles and missing photo metadata
- **THEN** the browser reads only photo candidates, supplies placeholders for missing metadata and does not modify or omit members from write-side validation
