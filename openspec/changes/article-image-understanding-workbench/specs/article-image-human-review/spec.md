## ADDED Requirements

### Requirement: Inspect the source and grounded plan together

The localized workbench SHALL show ordered article rich content and local originals, capture diagnostics, article understanding, source references and image-plan cards. Editors SHALL be able to navigate from a fact or shot reference to its source block and inspect an original asset. It SHALL retain the host UI primitives, responsive reading order, keyboard operation and reduced-motion behavior.

#### Scenario: Verify a proposed image
- **WHEN** an editor opens a shot and selects its supporting reference
- **THEN** the workbench locates the corresponding source block or original image and displays the shot rationale and final prompt

#### Scenario: Missing source material
- **WHEN** capture quality is partial or an original asset failed
- **THEN** the page identifies the affected location and offers repair or retry without displaying the article as fully analyzed

### Requirement: Keep edits and scene prompts consistent

The workbench SHALL protect unsaved edits against navigation and polling. Editing scene fields SHALL mark the final prompt as requiring synchronization; editing understanding SHALL mark dependent decisions for rechecking. Saving a changed plan SHALL increment its revision and clear its approval.

#### Scenario: Change a scene subject
- **WHEN** an editor changes the subject while the final prompt still describes the previous subject
- **THEN** the plan shows the synchronization requirement and cannot be approved until a synchronized version is saved

#### Scenario: Poll while editing
- **WHEN** the Host refreshes an article that has an unsaved local draft
- **THEN** the page retains the draft, reports any revision conflict and refuses stale saves instead of overwriting either version

### Requirement: Require explicit human review of an exact version

Only an explicit workbench review action SHALL approve a plan. The Host SHALL verify current revision, source and analysis-input identities, plan hash, capture eligibility and check/synchronization state before atomically recording approval. The analysis Agent and public article tools SHALL NOT expose an approve operation.

#### Scenario: Approve a current plan
- **WHEN** an editor confirms a saved, eligible and synchronized plan at its current revision
- **THEN** the Host records its source, input and plan hashes and marks that exact plan approved

#### Scenario: Attempt stale approval
- **WHEN** a caller submits approval after the plan or its adopted inputs changed
- **THEN** the Host rejects it and requires review of the current version

#### Scenario: Try to approve from the analysis Agent
- **WHEN** the analysis Agent inspects its available tools or attempts an approval submission
- **THEN** no approval capability is available and no human approval record is created

### Requirement: Invalidate review when adopted inputs change

Changes to adopted article content, participating images, business notes, understanding, shots or effective run parameters SHALL invalidate dependent approval. Updating a global rule file SHALL leave historical frozen plans intact until explicit reanalysis adopts it. Unrelated source-row metadata SHALL NOT alone invalidate a plan.

#### Scenario: Adopt changed business notes
- **WHEN** a source update changes notes that are adopted for the article's next analysis
- **THEN** the old approval cannot approve the new input and the new plan requires review

#### Scenario: Update rules without reanalysis
- **WHEN** a rule file changes but no new run has adopted it
- **THEN** the existing plan retains its recorded rules and approval and the page can indicate a newer rule version is available

### Requirement: Stop phase one at reviewed prompts

The plugin SHALL report image generation unavailable and SHALL NOT register or execute generation tools, actions or provider adapters in phase one. Capture, analysis, editing, approval, retry, recovery and batch processing SHALL make zero image-generation, publication, publication/distribution asset-upload or spreadsheet-writeback submissions. Image inputs or attachment transfers required by dedicated visual analysis SHALL remain permitted and separately identifiable from generation and publication requests.

#### Scenario: Approve a plan
- **WHEN** the user approves a plan
- **THEN** the final result is a reviewed prompt plan with no image-generation or publishing request

#### Scenario: Retry or resume processing
- **WHEN** an article is retried, resumed or included in a batch
- **THEN** only permitted source retrieval and analysis operations execute and generation remains unavailable
