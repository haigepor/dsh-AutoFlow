## ADDED Requirements

### Requirement: Load effective rules from versioned files

The analysis workflow SHALL explicitly load the shared package editorial references and configured profile rule files, validate editing preferences, and freeze effective contents, ordering and hashes before model execution. Skills SHALL guide Agent operation using the same domain rules. Source text and spreadsheet notes SHALL NOT override evidence requirements, human review or the phase-one generation restriction.

#### Scenario: Change a profile rule file
- **WHEN** a valid rule file changes before a new analysis starts
- **THEN** the new request uses its changed content and records a new effective rules hash while previous plans retain their frozen rules

#### Scenario: Change rules during an active task
- **WHEN** a rule file changes after an input snapshot has been frozen
- **THEN** the active task continues with its recorded snapshot and the next task resolves the new contents

#### Scenario: Missing or invalid configured rules
- **WHEN** a declared rule file is missing or contains invalid fields or values
- **THEN** preparation fails with an actionable error before model execution instead of omitting the file

### Requirement: Cover the complete article and actual image inputs

The system SHALL track input and processing coverage for every article block and original image. Long articles SHALL use bounded chapter-aware chunks followed by whole-article synthesis. The system SHALL record image bytes or persisted derivatives actually supplied to a compatible visual route and SHALL NOT equate an image URL or caption with visual understanding.

#### Scenario: Process an article beyond one context window
- **WHEN** the full article exceeds the configured single-request budget
- **THEN** all blocks are covered through chunk results and final synthesis before a complete plan can be submitted

#### Scenario: Original images require visual capability
- **WHEN** an article includes images but no configured route can accept their actual visual input
- **THEN** the task waits for configuration and does not claim completed image understanding

#### Scenario: Image or context budget is exhausted
- **WHEN** required content exceeds the configured total analysis budget
- **THEN** the system reports the unprocessed blocks or assets and withholds a complete plan instead of silently truncating input

### Requirement: Produce evidence-grounded article understanding

The understanding result SHALL include article type, purpose and audience, central message, section structure, important entities and facts, constraints, uncertainty and original-image relationships. Factual statements SHALL cite current source blocks or visual assets and distinguish source claims from interpretation. The result SHALL expose concise conclusions and evidence without requiring internal reasoning transcripts.

#### Scenario: Preserve a limiting condition
- **WHEN** an article states a numerical claim limited to a date, location or population
- **THEN** the understanding retains the value and its limitation with a supporting source reference

#### Scenario: Unsupported factual detail
- **WHEN** an understanding or image concept introduces a named location detail or witnessed event absent from the available evidence
- **THEN** it is removed, marked uncertain or returned for correction rather than saved as a verified fact

### Requirement: Plan new illustrations from article meaning

The system SHALL plan a cover and distinct inline concepts from article content using validated preferences for count and ratio. Original figures SHALL serve as understanding and review references rather than a required one-for-one replacement list. Each shot SHALL include purpose, source references, insertion position, editorial rationale, scene fields, avoidance instructions and a self-contained final prompt.

#### Scenario: Existing article has a different image count
- **WHEN** the source has several figures and the requested illustration count differs
- **THEN** the system selects concepts by article importance without matching every original image

#### Scenario: Too few supported distinct concepts
- **WHEN** the article cannot support the requested number of non-redundant images
- **THEN** the result reports the shortfall and its reason without inventing facts or padding with duplicate concepts

#### Scenario: Conceptual illustration for reported facts
- **WHEN** a news, medical or financial article cannot support a documentary scene
- **THEN** the proposal identifies a conceptual illustration and does not present it as a real event photograph

### Requirement: Validate submissions and retain reproducible inputs

The Host SHALL validate schema, coverage, current source and input hashes, references, scene/prompt synchronization and final result ownership before saving a reviewable plan. Model-visible rules, text, visual inputs and outputs SHALL be reconstructable through the dedicated DSH Session log and persisted attachments. Structural validation SHALL NOT be represented as semantic accuracy certification.

#### Scenario: Missing coverage or nonexistent reference
- **WHEN** a submitted plan omits a required chunk result or cites a nonexistent source block
- **THEN** the Host rejects it without advancing the article to review

#### Scenario: Inspect a historical analysis
- **WHEN** an editor inspects a saved plan
- **THEN** the system identifies its exact source, adopted business fields, effective rules, model configuration and visual input manifest

#### Scenario: Incomplete assistant response
- **WHEN** an assistant finishes a turn without a valid task-bound final submission
- **THEN** the task reports an incomplete result instead of treating idle status or prose as a completed plan
