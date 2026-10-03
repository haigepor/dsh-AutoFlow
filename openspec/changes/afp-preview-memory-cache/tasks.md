## 1. Cache ownership

- [x] 1.1 Add a plugin-local cache with successful Blob reuse, request coalescing and independent cancellation tests.
- [x] 1.2 Verify LRU, byte/entry/TTL limits, retry invalidation, leased URL ownership and late-response suppression.

## 2. Plugin integration

- [x] 2.1 Add validated deployment policy and Host scope to private page status without changing Agent status.
- [x] 2.2 Connect store credential/read/connection/Host/disposal invalidation and enforce read access before preview acquisition.
- [x] 2.3 Integrate all ImagePreview consumers, preserving lazy loading, decode handling, layout and retry behavior.

## 3. Verification and delivery

- [x] 3.1 Add owner-local behavior output and a repeatable request-count benchmark against the actual cache module.
- [x] 3.2 Update paired README descriptions and run focused/full plugin tests, build, syntax, UTF-8 and strict OpenSpec validation.
- [ ] 3.3 Update the installed web plugin after checking active jobs; verify served client, private policy and authenticated cache reuse without launching a browser.
- [x] 3.4 Review the limited diff and record rollback and manual visual/decoded-memory verification limits.

### Deployment status

Task 3.3 is BLOCKED on restarting the running Web Host: installed files and the served client match this implementation, but the live Host still returns the previous private status without `previewCache`. Updating an already installed bundle requires a restart under the existing plugin-manager lifecycle. No core code or application-wide restart was performed. An isolated cache using the real authenticated preview route passed; this does not establish automatic retention in the live workbench before the Host restarts. See `verification.md`.
