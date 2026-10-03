## ADDED Requirements

### Requirement: Confirm selected photos before adding

The AFP search page SHALL offer a localized icon action that opens a confirmation dialog for a snapshot of all selected photos, permits searching existing writable private collections, and submits only after explicit confirmation with write enabled and at most 120 photos.

#### Scenario: Add photos selected across pages
- **WHEN** the user confirms a private target for photos selected across search and collections
- **THEN** the system adds the snapshot to that target without removing existing relationships or clearing selections

#### Scenario: Missing permission or oversized selection
- **WHEN** write is disabled or more than 120 photos are selected
- **THEN** confirmation is disabled with a localized explanation and no write is attempted

### Requirement: Verify additions and report distinct outcomes

The Host SHALL check target membership, skip existing members, verify each addition, and report added, already-present, failed or uncertain outcomes without automatic retry. Existing copy callers SHALL remain compatible.

#### Scenario: Some images are already present
- **WHEN** a target already contains part of the batch
- **THEN** the target remains selectable and only absent photos are added

#### Scenario: Ambiguous write
- **WHEN** a relationship request or verification has an uncertain result
- **THEN** the UI retains the selected photo, reports uncertainty and does not automatically retry

#### Scenario: Legacy Host result
- **WHEN** a Host returns successful copy items without membershipChange
- **THEN** the UI reports completed photos without inventing added or skipped counts
