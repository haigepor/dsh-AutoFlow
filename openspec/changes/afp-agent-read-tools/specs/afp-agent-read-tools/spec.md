## ADDED Requirements

### Requirement: Actual photo search and pagination

The plugin SHALL expose `afp_photo_search` under the existing read feature and Session ownership requirement, using authenticated Host photo search with query, optional language, cursor and limit bounded by deployment pageSize. The result SHALL contain allowlisted metadata, terminal/pagination state and measured duration without credentials, signed media URLs or image bytes.

The plugin SHALL expose the additive `afp_photo_search_start` tool for first-page searches with required query, supported language and bounded limit, without a cursor property. It SHALL use the same authenticated Host operation and metadata projection as `afp_photo_search`. Existing callers that omit cursor SHALL remain supported.

#### Scenario: Start without a fabricated cursor
- **WHEN** an Agent calls `afp_photo_search_start` with query, language and limit
- **THEN** the tool reads the first page without a cursor and returns the continuation fields; adding a cursor argument is rejected before remote I/O

#### Scenario: Fetch the next photo page
- **WHEN** an Agent supplies the cursor returned by an actual search with the same query and language
- **THEN** the tool reads that page and returns items, hasMore, cursor and safe metadata; an empty or repeated cursor terminates pagination using the existing Host behavior

#### Scenario: Reject an invented initial cursor
- **WHEN** an Agent supplies the known invalid placeholder "0" or "?"
- **THEN** Host execution validation rejects it before a remote search and instructs the Agent to use `afp_photo_search_start`; repeating the placeholder cannot produce remote I/O, and tool descriptions communicate this rule without unsupported schema regex lookaround or silently restarting paging

### Requirement: Photo and collection metadata browsing

The plugin SHALL expose `afp_photo_details`, `afp_collection_list` and `afp_collection_items` as read-only tools. Collection listing SHALL describe named account-visible collections rather than just fixed category targets, exclude unnamed directory entries and report their excluded count. Member reads SHALL expose offset, total, hasMore and nextOffset without changing any membership; unnamed entries SHALL be rejected before fetching contents.

#### Scenario: Browse a shared collection
- **WHEN** an Agent selects an account-visible read-only collection and requests its members
- **THEN** metadata is returned with the collection permission fields and paging state, without any write or purchase

#### Scenario: A photo is absent
- **WHEN** a valid photo ID is not returned by AFP
- **THEN** details return an explicit not-found result rather than fabricating metadata

#### Scenario: An unnamed directory entry
- **WHEN** AFP returns an unnamed entry alongside a named shared collection
- **THEN** the Agent directory excludes the unnamed entry, counts it in meta.excludedUnnamedCount and keeps the shared collection; direct member reads of the unnamed entry fail with fixed collection-unavailable guidance

### Requirement: Safe actionable errors

AFP Agent errors SHALL preserve DSH tool-error status and carry fixed code, stage, message, action, retryable flag and measured duration. Invalid inputs, missing Session, disabled capability and recognized authentication/read failures SHALL be distinguished; unknown upstream errors SHALL NOT expose original exception text, credentials, signed URLs or response bodies. Write failures SHALL NOT recommend automatic retries.

#### Scenario: Whitespace search input
- **WHEN** a query contains only whitespace
- **THEN** the tool rejects it as invalid-arguments before remote reading and explains the input correction

#### Scenario: Mutually exclusive report identifiers
- **WHEN** both runId and planId are supplied
- **THEN** validation rejects the call before any report storage access

#### Scenario: Raw upstream error contains secrets
- **WHEN** a read fails with an unknown error containing authentication or signed-link data
- **THEN** the Agent receives only the fixed safe failure description

#### Scenario: A read is rejected
- **WHEN** a recognized GraphQL rejection or unknown read failure occurs
- **THEN** the error provides fixed read or parameter guidance without raw upstream text or partial-write advice and does not suggest repeating unchanged non-retryable input

### Requirement: Feature lifecycle and workflow evidence

All new registrations SHALL be disposed with the read feature and reads SHALL honor Session cancellation and existing Host read revocation. Plugin Skills SHALL distinguish planning, actual retrieval and visual screening. Existing success results and write confirmation SHALL remain compatible, and a keyless recorded Session SHALL cover the added calls and safe errors.

#### Scenario: Disable read capability
- **WHEN** read registrations are disposed and a new Session starts
- **THEN** none of the new tools are offered, pending reads are aborted by the existing Host lifecycle and old responses cannot publish a successful result
