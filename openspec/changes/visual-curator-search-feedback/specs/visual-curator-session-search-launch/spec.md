## MODIFIED Requirements

### Requirement: Delivery and task context remain scoped

Workspace materialization SHALL be confined to the selected Workspace's task directory, preserve existing unrelated files and verify source bytes. Native Session and plugin resource ownership SHALL remain enforced. Launch authorization SHALL cover only its own task results and SHALL NOT authorize unrelated private references or arbitrary file writes. The execution prompt MUST state that zero qualified results do not create a delivery directory; task reports SHALL expose an actual directory only after a committed delivery receipt, and SHALL direct Agents to read that receipt before inspecting files.

#### Scenario: Foreign resource
- **WHEN** another Session requests a private result or private launch materials
- **THEN** the operation is rejected without exposing download bytes or private paths

#### Scenario: Unsafe or replaced output directory
- **WHEN** the target directory no longer belongs to the selected Workspace or would overwrite an unrelated file
- **THEN** delivery fails visibly and leaves the unrelated files unchanged

#### Scenario: No qualified results yet
- **WHEN** search is running or settles without a qualified result
- **THEN** no actual delivery directory is claimed and the Agent reads saved task progress instead of scanning an expected path
