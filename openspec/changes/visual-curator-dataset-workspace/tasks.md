## 1. Export progress and dataset reads

- [x] 1.1 Capture target-file backups and define validated dataset progress/list/detail messages.
- [x] 1.2 Report real export verification, sample, file and save progress through existing run checkpoints; preserve output and cancellation/idempotence behavior.
- [x] 1.3 Provide owner-scoped, current-collection paged dataset summaries joining tasks and artifacts, plus bounded frozen detail reads.
- [x] 1.4 Verify progress, historical/orphan output joins, pagination, ownership and preview limits with keyless Host tests and expected output.

## 2. Workbench state and generation feedback

- [x] 2.1 Own submission identity, pending acknowledgement, scoped dataset pages/details and background progress in the Client store.
- [x] 2.2 Extract the existing task-card presentation and adapt gallery referencing and dataset generation without changing gallery behavior.
- [x] 2.3 Add the content-only generation mask and keep close/reopen functional before and after task acknowledgement.
- [x] 2.4 Verify close-before-acknowledgement, same-operation retry, scope changes and retained read failures in Client tests.

## 3. Dataset workspace and delivery

- [x] 3.1 Add the datasets Tab, filters, pagination, download actions and frozen read-only overview/rules/samples/files detail.
- [x] 3.2 Update typed locales, package documentation and owner-local UI expected output.
- [x] 3.3 Verify real assembled UI in desktop/narrow and light/dark modes, including background/failed/completed transitions and authorization failures without paid inference.
- [x] 3.4 Run focused/plugin checks, build artifacts then build check, documentation/OpenSpec validation, encoding/scope review and record final evidence.

Verification evidence: `.playwright-mcp/dataset-workspace-verification.md`. Production Host reads and assembled desktop feedback were checked; the complete browser scenario was interrupted by shared preview resource reloads. The same production factories and native primitives passed the remaining narrow/theme/detail transitions in an isolated browser fixture. Broad repository lint/doc-sync failures are recorded separately from this change.
