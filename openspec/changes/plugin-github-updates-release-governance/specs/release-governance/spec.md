## ADDED Requirements

### Requirement: Independent release families

Plugin and desktop releases MUST use independent versions, tags, assets and update selection; AFP releases SHALL use afp-v and desktop production releases SHALL use desktop-v.

#### Scenario: Plugin-only release
- **WHEN** AFP changes without a desktop carrier change
- **THEN** only the AFP package version and AFP release family are published, without changing Desktop latest or installer versions

#### Scenario: Windows installer release
- **WHEN** a Windows installer is released
- **THEN** the desktop family records its exact built source, signed installer and update metadata independently of AFP

### Requirement: Recoverable historical organization

Historical tags and source-only releases SHALL be inventoried with their source, original notes and proposed disposition before remote changes; published install assets and release tags MUST remain immutable.

#### Scenario: Source milestone without assets
- **WHEN** an old AutoFlow Release has no install assets
- **THEN** it is classified as a historical source milestone and receives an archival plan, not a fabricated installer release

#### Scenario: Historical cleanup
- **WHEN** destructive removal or tag migration is proposed
- **THEN** a concrete backed-up list and link impact are available for explicit authorization before execution

### Requirement: Important annotated milestones and isolated acceptance

Source milestones SHALL use the uniform milestone/ family and detailed annotations describing source, purpose, implemented changes, retained customization, historical validation and recovery use. Temporary update releases MUST use a separate family and isolated profile without changing formal assets or Desktop latest.

#### Scenario: Authorized tag reconstruction
- **WHEN** the user authorizes deleting the original tags and recreating important milestones
- **THEN** original objects and mappings are backed up, retained milestones resolve to the intended historical commits, and the formal AFP tag and assets remain frozen

#### Scenario: Acceptance cleanup
- **WHEN** real manual and automatic update acceptance finishes
- **THEN** temporary Releases, Tags, profiles, caches, packages and worktrees are removed and formal release assets are verified again
