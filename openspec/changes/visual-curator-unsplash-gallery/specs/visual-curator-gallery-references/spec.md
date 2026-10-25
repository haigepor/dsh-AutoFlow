## ADDED Requirements

### Requirement: Host-owned gallery reference tasks
The Host SHALL durably accept a fully enumerated photo selection with a fixed owner, account, target collection, reference role and operation ID. Accepted work SHALL continue after its initiating dialog, page or HTTP request closes. Repeating the same operation SHALL return the same task, and conflicting reuse SHALL fail before another task starts.

#### Scenario: Close the dialog after acceptance
- **WHEN** the owner confirms a collection selection and closes its dialog after the Host accepts it
- **THEN** the Host continues subsequent batches against the original collection and exposes committed progress independently of that dialog

#### Scenario: Change the visible collection
- **WHEN** the owner switches to another collection during referencing
- **THEN** the task retains its original collection, account and reference role and does not append to the newly visible collection

### Requirement: Reference task consistency and lifecycle
The Host SHALL permit at most one active reference task per collection, reject conflicting analysis and archival, separate committed success counts from in-flight registration, and retain confirmed results after cancellation. Unknown batch receipts SHALL stop further dispatch without automatic replay. Host shutdown SHALL drain admitted receipts before releasing persistence; unfinished tasks SHALL be exposed as interrupted after restart.

#### Scenario: Cancel after a committed prefix
- **WHEN** the owner explicitly cancels an active task after some references commit
- **THEN** confirmed references remain saved, later batches stop, and progress reports the final retained count

#### Scenario: A batch receipt cannot be confirmed
- **WHEN** a batch response cannot be reconciled with the selected photo IDs
- **THEN** the task reports that review is required and does not replay the batch or dispatch the next one

#### Scenario: Restart after an unfinished batch
- **WHEN** the Host starts with a task that did not reach a terminal state
- **THEN** it reconciles any durable batch receipt, retains confirmed references, and marks the task interrupted without automatic replay

### Requirement: Collection-owned progress presentation
The collection menu, workspace and open reference dialog SHALL share the Host task status and committed counts. The active collection SHALL display a loading animation, preserve access to other collections, and keep analysis and archival unavailable while its task writes. Ordinary referencing SHALL not invoke a vision model; an existing explicit reference-and-analyze action MAY request analysis after successful completion.

#### Scenario: Refresh while referencing
- **WHEN** the owner refreshes the browser during an accepted task
- **THEN** subsequent task reads recover its current status and progress without starting a replacement task or model call

#### Scenario: A previous Session responds late
- **WHEN** a task start or page read responds after the Client changes its authorized Session scope
- **THEN** that response does not populate the new scope's task or image state

### Requirement: Stable collection reference pagination
Reference pages SHALL be scoped to one collection and report its saved total and reference-role counts independently of loaded cards. Cursors SHALL validate the already-read ordered prefix, permit later appends, and reject a removed or reordered prefix. Progress reads SHALL not request a complete workspace snapshot for every unchanged poll.

#### Scenario: Append while the owner reads later pages
- **WHEN** background referencing appends photos after a collection page is read
- **THEN** its existing cursor remains usable and subsequent pages contain the remaining references without duplicates or skipped entries

#### Scenario: The prefix changes
- **WHEN** references before a cursor are removed or reordered
- **THEN** the Host rejects that cursor and the Client preserves visible cards while offering a refresh or retry

### Requirement: Automatic image-list loading
The image list SHALL load subsequent pages near the bottom of its actual scroll container without requiring a load-more click. It SHALL deduplicate concurrent page requests, retain loaded cards and filters during background refresh, and stop automatic retries after a page failure.

#### Scenario: Reach the list bottom
- **WHEN** the list sentinel enters the collection scroll viewport and another page exists
- **THEN** one page request begins and its cards are appended without resetting earlier cards

#### Scenario: A page fails
- **WHEN** a subsequent page request fails
- **THEN** loaded cards remain visible, automatic loading pauses, and an explicit retry can continue the same listing

### Requirement: Preserve existing material data
The change SHALL preserve existing material sets, image references, model profiles, completed analyses and gallery-account isolation. Gallery reference tasks SHALL store remote links and source metadata without copying image bytes. The existing synchronous gallery-import operation SHALL retain its semantics.

#### Scenario: Verify the enhancement
- **WHEN** browser acceptance creates synthetic reference tasks in an isolated profile
- **THEN** existing material-set identities, revisions, archive states and reference counts in the user's Host remain unchanged and no existing model task is rerun
