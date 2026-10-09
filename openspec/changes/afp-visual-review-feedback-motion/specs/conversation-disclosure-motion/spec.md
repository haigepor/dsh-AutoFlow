## ADDED Requirements

### Requirement: Symmetric conversation collapse
Reasoning and compaction bodies SHALL use shared collapse motion for opening and closing without immediate outer-height clipping or body removal.

#### Scenario: Close and reopen
- **WHEN** the user closes expanded content and reopens it during the transition
- **THEN** layout transitions continuously, content survives until exit completes, and the reopened body remains available

#### Scenario: Reduced motion and keyboard
- **WHEN** reduced motion is enabled or a keyboard user closes a body
- **THEN** reduced motion removes transitions and closed contents are inaccessible while the toggle remains operable
