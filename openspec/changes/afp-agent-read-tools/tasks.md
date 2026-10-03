## 1. Agent read tools

- [x] 1.1 Add regression tests for actual two-page search, details, full collection list and member paging through registered tools
- [x] 1.2 Register four read-only tools using existing Host operations and explicit safe DTOs with measured metadata
- [x] 1.3 Validate input, preserve cancellation/read revocation and return actionable safe errors without raw upstream data

## 2. Workflow and evidence

- [x] 2.1 Update two search Skills and plugin metadata/README for planning versus actual retrieval and safe error handling
- [x] 2.2 Update recorded keyless Session and expected output to exercise new tools, invalid input and disposal
- [x] 2.3 Run focused tests, plugin checks/build, locale/README pairing, UTF-8 and strict OpenSpec validation
- [x] 2.4 Verify runtime tool registration and read-only search/paging after safe Host reload; retain sanitized verification evidence

## Scope and rollback

Allowed paths are the AFP plugin and this change. Existing configuration UI changes and recipes.json are preserved. The pre-edit backup is `C:/Users/haige/AppData/Local/Temp/afp-agent-read-tools-Irt8ND`; source files are backed up with relative paths and scope.json records the base and starting status.

## 3. Read-only feedback repair

- [x] 3.1 Reproduce the reported initial cursor from actual Session calls and a same-query Host differential probe
- [x] 3.2 Reject the known invalid cursor placeholder before reading and add first-page schema/Skill guidance
- [x] 3.3 Separate read error advice, filter/count unnamed entries and reject unnamed member reads while preserving named shared reads
- [x] 3.4 Add failing regressions, update keyless Session snapshot and verify plugin tests, docs and encoding
- [x] 3.5 Reload the idle AFP Host on 3080, synchronize unedited managed Skills and retain scoped real read evidence in readonly-repair.md

## 4. Model schema compatibility repair

- [x] 4.1 Reproduce unsupported lookaround in all registered AFP schema inspection and remove cursor.pattern while preserving Host validation
- [x] 4.2 Record model-visible cursor schema in the keyless Session snapshot and run focused regression/static checks
- [x] 4.3 Reload the idle Host on 3080 and verify the updated definitions and a real read without claiming a live model API result

## 5. Explicit first-page search repair

- [x] 5.1 Verify the reported question-mark cursor against Session calls and the declared optional field
- [x] 5.2 Add a cursor-free first-page entry point, preserve existing search callers and reject known invalid placeholders before reads
- [x] 5.3 Update both search Skills, documentation, behavior tests and model-visible Session snapshot
- [x] 5.4 Verify plugin checks, real read pagination and managed Skill synchronization; retain limitations and rollback evidence
