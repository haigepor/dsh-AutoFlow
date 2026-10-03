## ADDED Requirements

### Requirement: Build keyword recommendations from positive search data

The plugin SHALL generate a deduplicated keyword catalog from its existing search profiles, preserve category assignments and curated Chinese aliases, and filter recommendations locally without AFP requests while typing. Negative query clauses and full search strategies SHALL NOT become ordinary keyword suggestions.

#### Scenario: Chinese or English input
- **WHEN** the user types a matching English keyword or Chinese alias
- **THEN** the menu offers ordinary search terms with category context

#### Scenario: Excluded landscape locations
- **WHEN** the catalog is built
- **THEN** explicitly excluded landscape locations are not promoted from that category

### Requirement: Accessible suggestion interaction

The menu SHALL preserve input focus, support Arrow keys, Enter and Escape, dismiss outside, stay inside the viewport and escape overflow clipping. Choosing a suggestion SHALL fill the input without executing a search.

#### Scenario: Input method composition
- **WHEN** the user presses Enter during Chinese composition
- **THEN** the menu neither accepts a suggestion nor submits a search

#### Scenario: Accept and search separately
- **WHEN** the user accepts a highlighted suggestion
- **THEN** the input is filled and no search occurs until a later explicit submission

#### Scenario: Normal caption search
- **WHEN** the user submits an ordinary query and then loads more results
- **THEN** the existing caption, language and cursor semantics are retained
