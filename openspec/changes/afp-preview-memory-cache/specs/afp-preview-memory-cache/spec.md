## ADDED Requirements

### Requirement: Shared successful previews

The AFP plugin SHALL reuse successful raster preview bytes across its workbench consumers within the current account and Host scope, and SHALL coalesce concurrent reads of the same preview.

#### Scenario: Repeated and concurrent consumers
- **WHEN** gallery, details, selection and download consumers request the same valid preview
- **THEN** concurrent consumers share one network request and later consumers use retained bytes without another request while the entry is valid

### Requirement: Independent cancellation and URL ownership

The cache SHALL maintain independent consumer cancellation and reference-counted object URLs; it SHALL cancel an unfinished shared request only when its last consumer leaves or the cache is invalidated.

#### Scenario: One consumer closes
- **WHEN** one consumer aborts while another still waits
- **THEN** only the first consumer is rejected and the shared request remains available to the other

#### Scenario: Eviction while displayed
- **WHEN** an entry is evicted while an image still holds a lease
- **THEN** that URL remains valid until its last lease is released and is revoked exactly once

### Requirement: Bounded retention and retry

The cache SHALL obey validated deployment entry, byte and TTL limits, evict least recently used retained entries, and retain neither failures nor aborted reads. A decode failure or explicit retry SHALL invalidate the matching cached version.

#### Scenario: Limits and expiration
- **WHEN** retained entries exceed a configured capacity or their fixed TTL expires
- **THEN** subsequent requests reload evicted or expired bytes and retained counts remain within the configured limits

#### Scenario: Failed preview recovery
- **WHEN** a request or decoded image fails and the user retries
- **THEN** the failed result does not prevent a fresh read and the retry does not reuse the invalid Blob

### Requirement: Account and lifecycle isolation

The plugin SHALL invalidate retained and in-flight previews on relevant credential updates, connection reset, read-feature changes, Host scope changes and disposal. Old completions SHALL NOT refill a new generation. Disposal SHALL drain owned requests.

#### Scenario: Account changes during loading
- **WHEN** the account is reset while an old preview is loading
- **THEN** old consumers are rejected, old URLs are revoked, and a late old response cannot populate the new account cache

#### Scenario: Read access is disabled
- **WHEN** the client observes the read feature disabled
- **THEN** it clears existing previews and denies new preview acquisition until read access returns

### Requirement: Plugin-local integration and verification

The implementation SHALL stay inside the AFP plugin and its change record, preserve existing lazy loading and image presentation, and verify reuse through isolated tests and request-count measurements. It SHALL NOT store credentials, signed media URLs, paid originals or persistent image files in the cache.

#### Scenario: Client and Host compatibility
- **WHEN** the upgraded plugin is installed with an existing deployment
- **THEN** missing cache configuration fields receive validated defaults, private page metadata supplies the cache policy, and Agent status output stays unchanged
