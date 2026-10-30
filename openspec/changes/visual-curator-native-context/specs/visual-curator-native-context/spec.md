## ADDED Requirements

### Requirement: Inherit registered model controls
New native visual tasks SHALL inherit the registered model context capacity and output/reasoning defaults through prepareCall, without applying legacy plugin generation overrides.

#### Scenario: Large-context registered model
- **WHEN** the model declares a 1M context and a 64K output default while plugin limits contain 8192
- **THEN** the native request uses the model output default and records the 1M context

#### Scenario: Historical task
- **WHEN** a frozen task lacks the new inheritance marker
- **THEN** its original output and reasoning controls remain unchanged

### Requirement: Reuse native input compaction
The native Compaction service SHALL price text inputs using its model policy and token meter, return no compression below pressure, and compact above pressure without modifying a Session.

#### Scenario: No input pressure
- **WHEN** retained input and observation text fit the resolved threshold
- **THEN** no auxiliary model request is issued

#### Scenario: Observation pressure
- **WHEN** observation text exceeds the resolved threshold
- **THEN** bounded native compression requests produce shorter text while immutable image identities, human judgments and output Schema remain available

### Requirement: Own compression requests durably
Visual tasks MUST count and record each compression call within their existing budget, preserve original observations, and stop dependent inference on failed compression.

#### Scenario: Cancel or invalid compression
- **WHEN** compression is cancelled, truncated, incomplete or does not reduce input
- **THEN** no final inference is dispatched and committed observations remain unchanged

#### Scenario: Reuse committed compression
- **WHEN** the same recorded compression request is needed after a restart
- **THEN** its committed output is reused without another model call
