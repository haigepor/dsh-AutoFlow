# Verification

## DONE — Implementation and checks

The cache lives entirely in `custom-plugins/workspace/dsh-plugin-afp`. Shared Blob retention, independently cancellable requests, request coalescing, leases, retry invalidation and lifecycle invalidation are implemented. Default retained limits are 300 images, 64 MiB and ten minutes. Zero entries disables retention. Active image leases and decoded image memory are outside the retained-byte limit.

- `npm test`: 127 passed, zero failed or skipped; includes cache integration, permission changes, disposal and the existing keyless session snapshot.
- `npm run build:client` and `npm run check`: passed.
- `pnpm run verify-translation-pairing -- custom-plugins/workspace/dsh-plugin-afp/README.md`: passed after regenerating the pairing record.
- `openspec validate afp-preview-memory-cache --strict`: passed.
- Scoped `git diff --check`, fatal UTF-8 decoding, no BOM/replacement characters and exactly one trailing newline: passed.
- Working-tree status outside the AFP plugin and OpenSpec matches the recorded starting status. Existing unrelated changes were preserved.

## DONE — Measured request reuse

`node scripts/benchmark-preview-cache.mjs` uses the actual loader/cache with a simulated 40 ms transport: six sequential consumers made six uncached requests in 274 ms, one cached request in 42 ms, and six concurrent consumers made one request in 41 ms. These timings do not measure browser painting.

An authenticated, read-only probe against `http://localhost:3080` read one actual AFP collection preview through the existing Host route. Two cache acquisitions made one network request, retained 23,360 bytes and recorded one cache hit; first acquisition took 2,770 ms and the second rounded to 0 ms. Disposal left zero retained entries and active URLs. The probe configured an isolated cache with the installed deployment defaults because the running Host has not yet activated the new policy.

## BLOCKED — Live Host activation

The installed client, configuration and four source modules match the workspace files byte for byte. The served client responds with HTTP 200 and contains the exact new client bundle. The private status action also responds with HTTP 200, but `previewCache` is absent. The running Host still has its previous imported module; the plugin-manager source explicitly requires a restart when updating an already installed bundle. Active AFP tasks and downloads were both zero before installation and during the final probe.

No application-wide restart or core HMR modification was performed. Full live-workbench retention remains pending a normal Web Host restart. With the old Host the new client continues displaying previews and coalescing in-flight loads, but does not retain completed Blobs without a policy. After restarting the Host and refreshing the page, repeat collection/image navigation to inspect cache reuse manually.

## DONE — Isolation and rollback

Modified implementation files: `config-schema.js`, `src/host/afp-service.js`, `src/client/afp-preview-cache.js`, `src/client/afp-client-store.js`, `src/client/afp-workbench-gallery.js` and generated `client.js`. Tests changed in `tests/preview-cache.test.js`, `tests/workbench-client.test.js`, `tests/configuration.test.js`, `tests/workbench.test.js` and `tests/fixtures/preview-cache.json`; the benchmark is `scripts/benchmark-preview-cache.mjs`. Documentation changed in `README.md`, `README.zh.md` and `README.i18n.yaml`. No new dependencies, persistent cache, core API changes or paid-media requests were introduced.

Original files and the starting status are saved under `C:\Users\haige\AppData\Local\Temp\afp-preview-cache-3iW9AQ`. Roll back only files changed by this cache work, restoring their matching backup copies; remove newly created cache/test/benchmark files only after checking for later edits. Rebuild and reinstall the plugin if rolling back the deployed files. The backup preserves the pre-existing AFP workbench changes.

No browser was launched. Visual checks, browser decode-memory measurements and automatic live-workbench reuse after Host restart remain unverified. The cache is memory-only and clears when the browser page is refreshed.
