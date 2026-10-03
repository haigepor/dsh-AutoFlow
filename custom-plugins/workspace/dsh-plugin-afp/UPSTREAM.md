# AutoAfpImg source record

Source repository: `https://gitee.com/sea-pigeon/afp-image.git`, local checkout `AutoAfpImg`, revision `414ac0a`. The snapshot contains no license file. No license is inferred for borrowed code or reference documents; confirm distribution permission before publishing an npm package containing them.

## Source mapping

The following files retain their source filenames under `src/vendor/auto-afp-img/`:

| Original location | Files |
| --- | --- |
| `src/shared/` | `http-client.mjs` |
| `src/skills/afp-core-news-search/scripts/` | `afp-search-planner.mjs`, `afp-subject-search.mjs` |
| `src/skills/afp-core-search-collections/scripts/` | `afp-api-client.mjs`, `ensure-afp-token.mjs`, `afp-photo-search.mjs`, `afp-collection-run.mjs` |
| `src/skills/afp-core-visual-triage/scripts/` | `afp-preview-client.mjs`, `openai-compatible-vision.mjs`, `afp-visual-triage.mjs` |

Adaptations flatten local imports, normalize UTF-8/LF and remove CLI launchers, runtime-file helpers and unused filesystem imports. Authentication and endpoint/model values are supplied by `afp-credentials.js`; the plugin does not read or update an external environment file. The borrowed mutation executor is not used: `afp-change-plans.js` owns confirmation, account/remote/run rechecks, cancellation, single-use and no-retry writes. Search cursor and category/vision gates remain in the adapted modules.

Six `skills/<name>/references/` directories derive from matching source Skill references. Their execution and credential references now point to DSH AFP tools and profile records. Skill entry documents are rewritten for DSH; the animal visual acceptance contract is retained. Local deployment paths, external environment files and temporary output paths are not part of the installed instructions.

## Upgrade verification

The preview adaptation negotiates only supported raster types, cancels redirect bodies before following, refuses embedded URL credentials and attaches a fixed blocked-host code with the hostname only. The owned Host accepts matching raster signatures with generic binary MIME and keeps signed media URLs private. The owned account reader uses the `user` query fields documented in AFP-Image's authentication and account references and present in its cached Hub query; it projects identity and credit fields without administrator or purchase operations. Collection photo filtering is an owned read-only projection and does not alter the vendor membership helper used by write validation.

Compare source revisions before replacement. Reapply the adaptations above, inspect category gates, protocol request fields, authentication and non-idempotent writes, then run package tests and the tarball/profile smoke. Keep installed Skill ownership paths, tool names and existing run/plan IDs stable. Current verification uses simulated interfaces; no production AFP collection is modified.
