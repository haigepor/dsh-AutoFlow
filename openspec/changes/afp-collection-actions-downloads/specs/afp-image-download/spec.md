## ADDED Requirements

### Requirement: Full-height download setup and persistent feedback
The download setup SHALL fill the available project Modal height with a fixed confirmation footer. Wide screens SHALL scroll quality and settings independently; narrow screens SHALL use one scrolling body. Loading feedback SHALL distinguish quote reads, directory selection, review and submission, and SHALL respect reduced-motion preferences. Accepted downloads SHALL show a global notification and a collapsed screen-edge progress control that remains available after navigating away from the workbench.

#### Scenario: Inspect an accepted background download
- **WHEN** the user starts a download and navigates to another page
- **THEN** a notification offers to open the progress card, and the screen-edge control shows Host batch status without keeping the workbench mounted

#### Scenario: Fold download progress accessibly
- **WHEN** the user presses Escape in the card or clicks outside it
- **THEN** the card folds and its hidden controls cannot receive keyboard focus

#### Scenario: Reset the profile during cancellation
- **WHEN** a cancellation response arrives after account or connection reset
- **THEN** the old request does not restore a download notification or progress state

### Requirement: Preview downloadable renditions and cost
The workbench SHALL retrieve available AFP image renditions and show each rendition's quality, dimensions, estimated size and credit cost, together with the current balance and total cost, before purchase.

#### Scenario: List available renditions
- **WHEN** the user opens download setup for selected images
- **THEN** the workbench shows every rendition returned by AFP, including paid high-resolution renditions, without buying any image

#### Scenario: Choose free default quality
- **WHEN** a photo has one or more zero-cost renditions
- **THEN** the workbench selects the highest-quality zero-cost rendition by default

#### Scenario: Apply a batch quality preference
- **WHEN** the user selects highest free, highest available or an exact AFP quality label in the toolbar menu
- **THEN** each matching photo selects its own eligible rendition ID, the menu reports matching counts, and unavailable or permission-blocked photos retain their existing choice
- **AND** any reviewed quote becomes invalid and no purchase or download is submitted by the selection itself

#### Scenario: Inspect compact photo rows
- **WHEN** the download list is ready
- **THEN** each row shows its selected dimensions, size and cost once, with the compact quality button retaining full per-rendition quotes inside its menu

#### Scenario: Reconfirm changed quote
- **WHEN** balance, rendition availability or total cost changes before confirmation
- **THEN** the workbench shows the updated quote and requires a new explicit confirmation before purchase

### Requirement: Confirm purchases safely
The workbench SHALL require explicit confirmation of the full batch credit cost before any paid purchase. Paid purchasing SHALL require the existing write feature. The Host SHALL treat AFP HTTP 202 as accepted but not completed, SHALL use only AFP-returned delivery validation data, and SHALL NOT automatically retry an ambiguous purchase.

#### Scenario: Confirm paid batch
- **WHEN** the user explicitly confirms the displayed batch total and the write feature is enabled
- **THEN** the Host submits each required purchase at most once and advances only when AFP provides validated delivery information

#### Scenario: Write feature is disabled
- **WHEN** the requested batch includes a paid rendition and the write feature is disabled
- **THEN** the Host rejects paid purchase before submitting a purchase request

#### Scenario: Purchase result is ambiguous
- **WHEN** AFP accepts a purchase but the Host cannot establish its delivery validation data
- **THEN** the Host records a pending outcome and does not repeat the purchase automatically

### Requirement: Download privately to a chosen directory
The workbench SHALL let the user choose a Host directory and filename policy, then download selected renditions through a profile job that continues across workbench view changes. Credentials, media keys, purchase tokens and signed URLs SHALL remain in the Host and SHALL NOT appear in client results or logs.

#### Scenario: Download confirmed free renditions
- **WHEN** the user confirms a batch containing only free renditions and chooses a destination
- **THEN** the Host streams files to that directory and reports per-image progress and outcomes

#### Scenario: Download confirmed paid renditions
- **WHEN** the user confirms the current total for a batch containing paid renditions
- **THEN** the Host performs the confirmed purchases and downloads delivered files without exposing short-lived URLs to the client

#### Scenario: Close or switch the workbench view
- **WHEN** a download job is active and the user closes or switches the workbench view
- **THEN** the job continues in the AFP Host and remains discoverable through task status

#### Scenario: Host stops during a download
- **WHEN** the AFP Host process exits before the batch completes
- **THEN** the active transfer stops and its last persisted outcome is reported as interrupted on the next Host start

### Requirement: Apply safe filenames and recoverable task results
The Host SHALL prefer a trustworthy AFP-delivered filename, otherwise use the photo GUID or ID with the rendition's file extension. It SHALL sanitize unsupported filename characters and avoid collisions with numeric suffixes. It SHALL persist concise batch and per-image results without absolute paths, credentials, media references or signed URLs.

#### Scenario: Use AFP filename or stable fallback
- **WHEN** a file is saved
- **THEN** the Host uses the AFP response filename if valid, otherwise the photo GUID or ID and actual media extension

#### Scenario: Apply custom affixes
- **WHEN** the user configures a prefix, suffix or both
- **THEN** the Host applies sanitized affixes to the basename and shows the resulting filename preview before starting

#### Scenario: Resolve filename collision
- **WHEN** the destination already contains the requested filename
- **THEN** the Host appends a numeric suffix without overwriting the existing file

#### Scenario: Read completed task after refresh
- **WHEN** the user reopens the workbench after a job has completed or partially failed
- **THEN** the workbench shows the persisted concise outcome and per-image status

### Requirement: Respect download limits and cancellation
The Host SHALL stream downloads with bounded concurrency, enforce its configured per-file byte limit, validate an allowed image signature, delete incomplete temporary files on cancellation or failure, and expose job cancellation.

#### Scenario: Cancel an active batch
- **WHEN** the user cancels an active download job
- **THEN** the Host stops remaining transfers, removes incomplete temporary files and records completed and cancelled per-image outcomes

#### Scenario: Reject oversized or invalid content
- **WHEN** downloaded bytes exceed the configured limit or do not match an allowed image signature
- **THEN** the Host rejects that file and removes its temporary file
