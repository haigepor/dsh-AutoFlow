## ADDED Requirements

### Requirement: Use one reusable extraction implementation

The plugin Host SHALL own article records and workflow state and consume the toolkit through a declared production library dependency. The workbench and standalone toolkit adapters SHALL use the same extraction implementation without synchronizing separate business state files.

#### Scenario: Capture from the workbench
- **WHEN** the user starts article processing in an installed profile
- **THEN** the Host invokes the declared toolkit extraction entry and persists its result in the profile-owned article store

#### Scenario: Install without the source checkout
- **WHEN** the packaged plugin is installed in a clean supported runtime
- **THEN** the extraction entry and its production dependencies resolve without repository-relative imports

### Requirement: Preserve ordered article rich content

The system SHALL capture browser-rendered article content as ordered typed blocks preserving heading levels, paragraphs, emphasis, safe links, list relationships, quotes, table cells and figure positions. It SHALL exclude site navigation, advertising, recommendations, comments and page controls from the article preview and model input.

#### Scenario: Capture a structured article
- **WHEN** an article contains headings, linked emphasis, nested lists, a table and inline figures
- **THEN** the snapshot retains their structure and order and the preview corresponds to the expected article block sequence

#### Scenario: Remove page furniture without removing figures
- **WHEN** navigation and recommendations surround an article whose legitimate image uses a media-class wrapper
- **THEN** unrelated blocks are removed and the article figure and its caption remain

### Requirement: Retrieve and identify article image assets

The system SHALL resolve public image sources before destructive pruning, including responsive and lazy sources, download the highest available source under configured limits, and persist verified bytes, content hash, MIME, dimensions and article positions. It SHALL retain captions, alt text, credits and each occurrence while deduplicating identical bytes. It SHALL expose missing or invalid assets instead of silently dropping them.

#### Scenario: Responsive and delayed images
- **WHEN** a supported article uses picture, srcset, long source attributes and images loaded after bounded scrolling
- **THEN** all expected figures have local verified assets and retain the expected order and captions

#### Scenario: Duplicate asset occurrences
- **WHEN** identical image bytes appear in two article positions with different captions
- **THEN** storage reuses the asset bytes while preserving both occurrences and their individual text

#### Scenario: Failed or oversized image
- **WHEN** an article image cannot be downloaded, decoded or accepted within configured limits
- **THEN** the snapshot records that image's safe error and does not pass automatic analysis readiness

### Requirement: Report capture quality with evidence

The system SHALL distinguish passed, needs-review, partial and failed capture quality with diagnostics and declared checks. It SHALL NOT infer completeness solely from text length, network idle or DOM size stability. Known missing content SHALL prevent automatic analysis until repaired; uncertain extraction scope SHALL require explicit source review with recorded evidence.

#### Scenario: Static introduction exceeds the minimum length
- **WHEN** a page initially contains more than the minimum article length but loads later sections through JavaScript
- **THEN** processing waits within the configured browser budget and either captures the expected final sections or reports unresolved content without starting analysis

#### Scenario: Unhandled article pagination or informative graphics
- **WHEN** the page indicates additional article pages or unsupported graphics carrying article information
- **THEN** the system identifies the unresolved content and requests review or repair instead of marking the article complete

#### Scenario: Review an uncertain extraction
- **WHEN** an editor verifies an uncertain article boundary against the public page, no known missing blocks or assets remain, and the editor chooses review-and-analyze
- **THEN** the system records the review and permits an explicit analysis start without claiming a universal completeness guarantee

### Requirement: Respect access and preview safety

The system SHALL apply existing public-network policy to browser navigation, redirects, data requests and image retrieval, use an isolated browser context, and reject recognized access gates. Preview rendering SHALL remove executable content and unsafe URLs and SHALL read local assets through authenticated opaque identifiers rather than caller-selected filesystem paths.

Local browser fixtures SHALL use a test-only injected policy allowing the exact fixture endpoint; this exception SHALL NOT become a production setting or weaken production rejection of local destinations.

#### Scenario: Restricted article
- **WHEN** an article resolves to a login, payment or human-verification gate
- **THEN** processing reports the actual restriction without attempting to bypass it or planning from the gate text

#### Scenario: Unsafe resource or HTML
- **WHEN** content requests a disallowed network destination or contains executable preview attributes
- **THEN** the request is rejected or the executable content is removed and no local file or credential is exposed

### Requirement: Version content and separate asset storage

The source hash SHALL include ordered article semantics, image content and figure relationships and exclude capture timestamps and temporary storage paths. Images SHALL be stored outside the bounded index. The store SHALL publish complete records atomically and SHALL preserve schema:1 records and historical plans during migration without treating legacy plain text as a new complete capture.

#### Scenario: Only an original image changes
- **WHEN** a participating original image changes bytes while article text remains unchanged
- **THEN** a new source hash is produced and results depending on the prior snapshot cannot be used as current results

#### Scenario: Source signature changes without content change
- **WHEN** a temporary image URL changes but verified image bytes and article semantics remain identical
- **THEN** the source hash remains unchanged

#### Scenario: Interrupted legacy migration
- **WHEN** migration stops before the new record set is fully published
- **THEN** the original records and backup remain intact and a retry can safely finish or report failure without partial index references

#### Scenario: Preview a migrated legacy article
- **WHEN** the user opens an existing schema:1 article after migration
- **THEN** its identifier, text, old plan and historical approval remain available and the workbench requires recapture for the new complete-content workflow
