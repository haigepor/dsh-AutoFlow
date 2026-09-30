# Custom bundle architecture

English | [中文](architecture.zh.md)

## Summary

A custom bundle is an npm package with a `dsh.bundle.patch` document. A profile installs the package as a dependency and selects its Cordis rows through a patch layer. The [demo](demo/README.md) implements optional content injection, a Host operation, an Agent tool, and Client UI; each is optional in a derivative bundle.

## Package and identity

Keep one independently versioned npm package per `custom-plugins/workspace/<name>/`. `workspace/` is a source area, not a pnpm workspace or publishable package. `demo/` remains the reference package and does not share release state with a maintained plugin. Each package publishes `package.json`, `cordis.patch.yml`, Host ESM entry files, optional `client.js`, locale JSON, icon, assets, and documentation. Include every runtime file in `files` and use explicit `exports` for all patch row module names. Do not add an application `bin`; only DSH profiles start supported Node apps.

When copying demo, change together: the npm `name`, patch row `name` specifiers, Client module `id`, UI registration `key`, Host action namespace, prompt marker and private ownership directory, Skill directory and its frontmatter `name`, icon, locales, and peer dependencies. Keep row `id` stable after release because feature selections persist by row ID in each profile. If a row ID must change, ship a migration or document the reset before publishing the new version.

## Composition and feature selection

`dsh.bundle.patch` names the patch YAML; its `insert` entries are independently mounted Cordis rows. The root row can own Client UI and management actions while optional rows own prompt, Skill, and executable behavior. Each registration is a lifecycle effect that is removed when its row unmounts.

`dsh.bundle.features` is an optional array of `{ id, rowId, title, description, details?, kind?, defaultEnabled }`. Every feature ID and row ID must be unique, and `rowId` must name exactly one inserted row whose `disabled` value matches `defaultEnabled`. `kind` is one of `prompt`, `skill`, `script`, `ui`, or `other`; it gives the Plugins page an explicit category and icon. Omit it only for an existing feature that must retain the legacy flat list. Text may be a string or localized object with `en`. Existing bundles without this array keep their original install flow. The plugin manager reads the profile's last matching patch override to report desired status, writes all selected rows in one profile edit, and reloads the runtime. A failed update restores the profile manifest and patch before reloading. The CLI uses declared defaults; the Web installer asks for selections after download and before bundle activation. The detail page remains available while the bundle is off, so choices can be prepared before activation. Its row list still reports runtime state and errors.

`dsh.bundle.examples` optionally declares up to six `{ id, prompt }` entries with unique IDs and localized prompt text. Selecting one opens a new Session and fills its composer without submitting it.

Feature choices belong to a profile, but `$DSH_HOME/AGENTS.md` and `$DSH_HOME/skills` belong to the Home. Any active profile can make this content visible to another profile sharing that Home. Do not describe feature toggles as profile-isolated prompt or Skill visibility.

## Host execution and Client UI

### Directory and live feature configuration

The reference package lives at `custom-plugins/docs/demo`; maintained packages live at `custom-plugins/workspace/<name>`. Keep exported lifecycle entries at the package root, owned runtime code under `src/host/`, browser sources under `src/client/`, and attributed protocol adaptations under `src/vendor/<source>/`. `skills/` contains instructions and references only. Root `cli/` contains DSH-managed task adapters; `scripts/` contains package build/check scripts. Use domain-prefixed kebab-case source names. Generate client.js from browser sources. Neither root entries nor CLI adapters are standalone application bins.

An optional `dsh.bundle.featureConfig: "./config.json"` selects version-1 JSON configuration. Its template has a complete boolean features map keyed by feature ID. First use creates `<profile>/.plugins/<package>/config.json`, migrating explicit legacy row selections. Page edits, individual row switches and manual edits then share that file. Startup projects it into Cordis rows; HMR watches selected bundles' files and adjusts registrations when selection changes. Profiles without HMR require restart. JSON overrides legacy profile feature patches; Home and launch overlays remain higher priority. Invalid files are never rewritten. Failed managed activation restores the file and prior running choices. Upgrades retain existing selections; feature additions, removals or renames require an explicit version migration. Bundles without this declaration retain patch-based behavior.

### Three shared page entries

Register `settings.section` for settings navigation/content, `sidebar.panellist` plus a `main` entry with the same stable id/key for global panels, and `conversation.view` plus its `uiConversation.views` target builder for conversation tabs. Each position registers and disposes independently and reuses one workbench and profile state source. Never target compiled CSS classes. Removing a selected entry returns navigation to an available page. Client calls Host through Remote; locale owns text, while shared Switch and theme tokens own control styling.

AFP page tasks belong to the profile; Agent tasks belong to a Session. Closing a view leaves work running; disabling execution or the bundle cancels and drains related jobs. Page writes display exact targets and counts before submitting an expiring, one-time confirmation credential; Agent writes retain DSH Session approval. Never persist confirmation credentials in reports or sessions or automatically retry non-idempotent writes. See [AFP](../workspace/dsh-plugin-afp/README.md) for the owning directory/configuration/write reference.

Host code owns Node APIs, files, child processes, tools, and service calls. An executable row can register a Host action with `pluginManager.registerAction(packageName, id, run)` and return its disposer through `ctx.effect`. The bundled script is called only from that action; it is not an application entry point. The Agent tool and Client button call the same operation. `pluginManager.invokeAction` exposes a live registered action through the existing Remote; it refuses calls after the row unmounts and bounds the returned text. Validate untrusted action input in the owning Host action and pass cancellation to child processes.

Client code is the package's `./client` module. The package's `dsh.client` declaration names its platform and Client dependencies. Register UI through `ctx.slots.inject` so the contribution follows slot availability and unloads with the package. Use `plugins.bundle.config` keyed by npm name for the bundle's own detail page. Use `plugins.detail.section` for an additional section on another plugin's bundle, row, or official-plugin detail. Use `settings.section` for a Settings sidebar item and page; `plugins.row.config` belongs to one row, while `plugins.item` belongs to an official card. See the [plugin manager](../../packages/client/ui-plugin-manager/README.md) and [Settings](../../packages/client/ui-settings/README.md) contracts for registration details and other slots. Localize all visible copy. Keep Host operations behind Remote calls; a browser button must not execute local files directly.

When the bundle is disabled, its Client entry and Host root row disappear, so Settings navigation and package-owned detail content disappear. The manager's generic installed card, feature choices, and example prompts remain visible. The demo uses `settings.section` for script execution and permanent removal; it leaves `plugins.bundle.config` empty to avoid repeating status on the bundle page.

## Global content ownership

The demo adds a unique marked block to `AGENTS.md` and manages one named Skill directory. It leaves text outside the block and other Skill directories alone. Each active prompt or Skill row records a process/profile lease in `$DSH_HOME/.managed-plugins/<package>/state.json`. When the last live lease ends, the plugin moves its content to the private `inactive/` directory, outside normal scans. A later activation restores that copy before using the packaged default. Prompt and Skill can be stopped or their inactive copies permanently removed independently. Removal refuses while any active lease remains. A management operation checks old process IDs, parks content left by a dead process, and rejects damaged markers, name collisions, or an unsafe inactive conflict without overwriting user files.

The bundle switch retains profile selections and inactive copies. Turning it on restores only selected features. Turning it off cannot erase text already recorded in a conversation; start a new conversation to verify the model no longer receives it. Package upgrades should preserve marker names and ownership paths, or include an explicit migration. Never overwrite a user's entire `AGENTS.md` from a snapshot.

## Build, install, and recovery

Run the demo tests, `npm pack --dry-run`, and the repository's focused plugin-manager tests before distribution. Verify the tarball contains every module referenced by the patch and the Client entry. Install a local folder or tarball with `dsh plugin --profile <name> add file:<absolute-path>`; after publication use `dsh plugin --profile <name> add <package>@<version>` or **Plugins → Add plugin**. The installer shows the package's localized title, description, icon, and feature choices from its manifest. No global npm installation is required. A profile without live reload or with newly replaced JavaScript may need restart.

For a failed activation, inspect the row's error and the reported Home path. Repair a damaged marker or move a conflicting user Skill to another name before retrying. Keep edits to active plugin content if desired: they become the next inactive copy. If a dead process left a lease, the next content-management operation reconciles it. Preserve `inactive/` when uninstalling the npm package if the user may want that content; remove it only through the explicit permanent-removal action after all profiles stop using it.

## Dev Note

None.

Feature `description` is a short summary; optional `details` expands inline, both with English fallback. Feature type groups stay visible, initially show four items and offer View more for the rest; only the component list folds. A configurable feature registers `plugins.row.config` under `<package>#<rowId>`; its switch gains an edit control that renders `view: page` in a dialog. Secrets go only to DSH credentials. Deployment edits use `configEditor.edit` validation, locking and profile patch persistence; feature JSON stores booleans only.
