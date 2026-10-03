## ADDED Requirements

### Requirement: Protected credential form

The form SHALL display the saved username and SHALL mask password, token and vision-key drafts by default, with independent reveal controls. Saved secrets MUST NOT be returned to the Client.

#### Scenario: Reveal and save a secret draft

- **WHEN** a user fills and reveals the vision key, then saves successfully
- **THEN** other secrets remain hidden and the saved key draft is cleared and masked again

### Requirement: Read-only authenticated account profile

The workbench SHALL display the authenticated user's identity and real credit balance beside the account form, with independent skeleton, failure and retry states. The read MUST NOT perform purchases, administrative mutations or remote collection writes.

#### Scenario: Successful token acquisition

- **WHEN** token acquisition succeeds and the account section is visible
- **THEN** the profile read displays available name, email, login, client ID and credit amount, including a zero balance

#### Scenario: Missing credit or unavailable profile

- **WHEN** profile fields are absent or the profile request fails
- **THEN** the workbench displays unknown values or a retry state and preserves credential form drafts and token status
