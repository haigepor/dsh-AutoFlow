---
description: "AFP photo search, resumable visual dry-runs and explicitly confirmed private-collection writes."
kind: "package-bundle"
---

# dsh-plugin-afp

English | [中文](README.zh.md)

## Summary

An independent npm bundle for DSH profiles. Read tools, visual refresh, remote writes, six Skills and three workbench entry positions can be selected independently. Defaults enable all three Agent tool entries, all six Skills and the global panel; the settings entry and conversation tab start disabled. Remote writes still require a plan and explicit confirmation. All page positions show the same profile-owned tasks and reports. Closing a page or switching sessions does not stop a task.

## Install and develop

From this directory run `pnpm install --ignore-workspace --config.auto-install-peers=false`, `npm run build:client`, `npm test`, `npm run check`, and `npm pack`. Install the resulting tarball with `dsh plugin --profile web add <absolute-tarball-path>` or through Plugins → Add plugin. A local directory also works: `dsh plugin --profile web add file:D:/project/deepseek-harness/custom-plugins/workspace/dsh-plugin-afp`. Use this checkout's DSH: earlier published runtimes do not support the new featureConfig declaration.

After publishing a reviewed package with your npm account, users install `dsh-plugin-afp@<version>` through the same plugin page or `dsh plugin --profile web add dsh-plugin-afp@<version>`. Do not install it globally. The package defines no application bin. Source attribution and publication limitations are in [UPSTREAM.md](UPSTREAM.md).

## Directory reference

Root `index.js`, `execute.js`, `skill.js` and generated `client.js` are exported lifecycle entries. `config-schema.js` validates deployment settings. Host implementations live under `src/host/afp-*.js`; browser implementations live under `src/client/afp-*.js`; adapted protocol and category policy modules live under `src/vendor/auto-afp-img/`. `skills/` contains instructions and references only. Root `cli/afp-task.js` exports a DSH-managed task adapter calling the same Host service as the UI; `scripts/` contains package build/check scripts. Edit browser source and run `npm run build:client`, rather than editing generated client.js.

## Configuration

The packaged `config.json` is an initial template. The authoritative user file is `<profile>/.plugins/dsh-plugin-afp/config.json`, containing `version: 1` and a complete boolean `features` map. Plugin-page changes and manual edits use this same file. HMR watches it; profiles without HMR require a restart. Invalid files remain unchanged and produce an error; the last running configuration remains in place during a failed HMR read. A managed save that fails during activation restores the previous file and running choices. Explicit legacy row selections migrate on creation; subsequent startup and upgrades retain the user file. Renaming/removing feature IDs or changing file versions requires an explicit migration rather than overwriting selections.

Feature keys are `read`, `refresh`, `write`, `ui-settings`, `ui-panel`, `ui-conversation` and the six Skill directory names. The plugin page and workbench distinguish selected state from actual running state. Home/command-line deployment overlays remain higher priority. The root bundle toggle retains all choices. Removing one UI entry only removes that entry; disabling refresh/write cancels and drains corresponding jobs. There is no prompt-injection feature in AFP.

Credentials are resolved through the DSH credential service using `AFP_ACCESS_TOKEN` or `AFP_USERNAME` + `AFP_PASSWORD`, and `VISION_API_KEY`. Only reference names are configurable here, never credential values. Token cache remains in the credential provider. The configuration dialog enables Get token only after both AFP username and password are entered; it saves them, then reuses the runtime login flow to acquire or refresh the token. The button shows its spinner while the request runs, and the token is never returned to the page or written to plugin JSON. Set `visionBaseUrl` and `visionModel` on Cordis row `afp`; see [config.example.patch.yml](config.example.patch.yml). Endpoints, model settings, timeouts, limits and `pollIntervalMs` are deployment fields, not feature JSON. The legacy deployment `allowWrites` field is accepted for stored-run compatibility and no longer grants permission; the `write` feature row controls writes. Token-only account identity changes when its token changes; username-based accounts keep stable identity.

## Workbench and tools

`settings.section`, `sidebar.panellist` + `main`, and `conversation.view` are independent lifecycle registrations. The workbench offers credential presence, per-feature switches, category selection, collection counts, offline query planning, visual dry-run/resume/cancel, saved reports and append/replace/clear plan confirmation. Tasks belong to the current profile; the conversation tab shows these same tasks, not a separate Session queue. The conversation shell displays tabs for an existing nonblank conversation. Removing the global entry returns its selected panel to Conversation; settings/conversation navigation follows the host shell's fallback.

Agent tools keep their stable names: `afp_status`, `afp_search_plan`, `afp_collections`, `afp_report`, `afp_plan_change`, `afp_refresh`, and `afp_apply`. Agent jobs belong to the invoking Session and use DSH approval. Page jobs belong to the profile. Page write previews return a one-time, expiring confirmation credential; confirmation is consumed before admission and is invalid after a restart or disabling writes. Both paths recheck account, exact private target names, complete remote membership and the referenced run before mutation. Plans are consumed before the first remote change. Writes are never automatically retried or rolled back; cancellation and failure may leave partial results. Read the retained report and inspect collections before creating a new plan.

## Content and recovery

Six Skill rows hold independent process/profile leases under `$DSH_HOME/.plugins/dsh-plugin-afp/skills/`. The last holder moves owned content out of `$DSH_HOME/skills/` into a private inactive directory. Edits to owned content are retained and restored; same-name user content, damaged ownership markers, symlinks and conflicting copies are refused. Because the scan directory is shared, another profile using the same Home can still expose a Skill. Dead-process holders recover on the next lease operation. Existing Session history is not erased.

Run and plan UUIDs remain stable under `$DSH_HOME/.plugins/dsh-plugin-afp/profiles/<profile-hash>/`. Failed/cancelled visual batches retain pending candidates and cursors for resume. Home-wide account/run locks prevent concurrent operations; an incomplete lock or leftover recovery guard refuses work and requires inspection after stopping its owners. Reports contain counts and sanitized failure information, not credentials or preview bytes. Local run files still contain candidate metadata and should be treated as private data.

## Verification

`npm test` uses simulated AFP interfaces and isolated temporary Homes; it performs no live AFP writes. The Session snapshot consumes repository `pnpm run build:lib` artifacts and explicitly skips in standalone copies without them; it records the real Agent loop calling offline search and tool removal after disposal. `npm run check` checks syntax, exports, defaults, shipped documents and UTF-8. Repository tests cover JSON selection migration, row toggles, manual HMR edits, activation rollback and legacy bundles. Packed-profile installation and browser verification use the built checkout. Simulated success does not establish production API availability, account permissions or image licensing.

## Dev Note

See the shared [custom-plugin architecture](../../docs/architecture.md) for package and UI-slot conventions.

## Feature information and configuration dialogs

The detail page shows feature type groups directly with View more for long lists; only the component list folds. Select a feature name to expand purpose, requirements and stop behavior inline. Script/tool edit controls open a shared configuration dialog using DSH Modal, Input and Button. Common model and budget fields are directly editable; Advanced settings holds full JSON. Four credential fields write only to DSH credentials under current deployment references; blank preserves existing values. Deployment JSON carries references, endpoints, models and budgets and saves/reloads through the profile editor. Deployment saves cancel active tasks; credential saves do not reload. Each save reports its own outcome; successful credential writes are not undone by a later deployment failure. Reopen after changing references before saving credentials.
