# Visual Curator releases

English | [中文](README.zh.md)

## Summary

Release 0.2.17: Choose a Codex image account or a configured OpenAI API key and image model for each new crop batch. Official-key results use their reviewed native resolution; Codex results use ESPCN x3 only after review. Cosmetic objects that cross the original crop receive natural endings inside the finished wallpaper.

AutoFlow ships this independent bundle and lists it under Installed plugins. Existing activation choices remain unchanged. [release.config.json](../release.config.json) owns the stable `visual-curator-v<version>` family and `visual-curator-update.json` metadata, separately from AFP and application releases.

## Local tests and formal releases

Run from the repository root:

```sh
pnpm run dsh-plugin-visual-curator:local
pnpm run dsh-plugin-visual-curator
```

`:local` builds a uniquely versioned local archive for manual Desktop installation, permits uncommitted edits and retains the stable update source. The command without a suffix publishes the reviewed stable manifest version through the existing native Actions and waits for the official update index. Bump the stable version and release notes, commit and push before formal publication. Neither command commits a branch, installs a plugin or restarts Desktop.

The [local testing guide](../../../release-governance/local-development/README.md) owns the shared five-plugin commands, progress and check options, manual archive replacement, local-version precedence, Desktop source preview and the proposed common importer. The old `--prepare-only --allow-dirty` invocation remains a local-only alias.

## Prepare and publish

Read the [release workflow Skill](../../../../.agents/skills/dsh-custom-plugin-release/SKILL.md) and [release policy](../../../release-governance/README.md). Review and commit the source, then prepare:

```sh
pnpm --filter dsh-plugin-visual-curator run release:prepare --out .artifacts/visual-curator-release
```

Preparation runs package tests and prepack, verifies the Host, Client, tools, skills and page entries, patch, icons, locales and notices, and creates the tarball, `SHA256SUMS` and update metadata. Metadata fixes the source commit, version, byte size and digest. `--allow-dirty` permits local rehearsal only. The [custom plugin workflow](../../../../.github/workflows/release-custom-plugins.yml) checks four native platforms and publishes a verified draft with `latest=false`; public assets and tags remain immutable.

## Runtime updates

The plugin detail page uses the existing check, update and automatic-update controls. Automatic installation requires explicit opt-in; it does not restart the application. Restart loads the matching Host, Client and profile patch together. Saved styles, references, tasks, feedback, model settings, credentials, activation and feature choices remain in their owning profile storage.

The tarball requires the native LLM, attachment, jobs, storage and Client capabilities declared by its peer dependencies. App-owned components require a matching AutoFlow build. Keyless release tests do not validate live image-source login, paid vision calls or source permissions. Download/install and old-version update acceptance are additional checks when requested.

## Dev Note

None.

## Visual Curator 0.2.13

New reference analyses automatically organize and save a dataset, including provisional observation packages when references or matching rules are incomplete. Dataset lists group versions and identical exports, show compact role counts and changes, and retain every historical export ID. Effective roles, matching-rule totals, negative reasons and conditional applicability remain explicit.

Update after current work finishes and restart AutoFlow. Existing data and frozen tasks retain their saved contents; new model explanations remain unconfirmed. Keyless release checks do not establish live paid-model output quality.

## Visual Curator 0.2.11

The reference dialog now places Bookmarked photos before named collections. Both sources support explicit selection, paged select-all, retry and positive or negative references. Changing the account clears the previous list and selection. An account without named collections can still open its bookmarks.

Update the plugin and restart to load the new Client. Existing gallery credentials, image records and Desktop update settings remain unchanged.

## Visual Curator 0.2.10

Completed reference datasets are scoped to their training collection and application profile rather than their creating conversation. Historical complete packages remain selectable across conversations and configured models without reanalysis, including packages saved by older Session-scoped versions. Each search retains the selected package and its checksums; partial observation exports remain supporting data. Existing Session task logs and private image permissions are unchanged.

Update the plugin and restart after current tasks finish. No user-data rewrite is required. A desktop whose plugin update button fails before sending the request needs the matching new Desktop host first.

## Visual Curator 0.2.8

Search adds a pool of 50/100 unique candidates and batch screening of actual thumbnails, followed by full review of retained and uncertain candidates. Screening cannot qualify a selection, and originals download afterward. Bounded screening retries fall back to individual review without treating technical failures as visual rejections. Pause, restart and the response/checkpoint commit gap reuse saved work within the same task budget. Model settings expose pool size, batch count and screening resolution; task cards show separate actual phase counts.

Fixes rules supported only by negative examples being disabled, required exclusions being averaged away, and source-rejected images being reviewed again in later conversations. Stable photo identities exclude known images within the same collection even after rewording a task or changing models. Technical failures and uncertain images remain retryable. Query guidance reflects real Unsplash tests and retains current enabled subject and scene constraints. Multiple keywords are not strict AND; actual pixels still decide final results.

Update the plugin and restart AutoFlow after current tasks finish; no desktop reinstall is required. Existing tasks retain their workflow and datasets retain their frozen content. To recover rules omitted by older versions, select All roles → Reuse and organize and use the newly generated complete dataset. Compatible observations need no repeated per-image analysis; exporting the old profile alone cannot restore missing rules.

## Visual Curator 0.2.7

Saved reference observations, automatic style profiles and reference datasets can be used with a different configured vision model. Switching models preserves analyzed status, original model/request records and existing dataset files. New searches and crops freeze the selected reviewer; paused tasks continue with their original model after restart. Incremental analysis reuses committed observations across models, while full reanalysis requires explicit confirmation. Changes to images, rules, judgments or processing still invalidate affected observations.

Analysis selects all references, positive examples only or counterexamples only, independently of reuse or reanalysis. Positive batches describe desired transferable traits; negative batches retain supported mismatch reasons and uncertainty without adopting them as target style. Other roles retain valid observations. Complete evidence is consolidated into a matching prompt and checksummed dataset automatically; partial results stay saved until the remaining references are analyzed. Failed package commits can retry without another model call. The latest complete package stays first, with historical complete versions available for search while a new analysis runs or is paused.

The reference badge says “Needs reanalysis” when evidence changes. Update the plugin and restart after current tasks finish; no data migration or desktop installer is required. Human-published releases and controlled comparisons retain their reviewer qualification checks. Keyless checks do not validate paid model output.

## Visual Curator 0.2.6

New image searches refresh readable mismatch history when the Run is admitted, including confirmed rejections saved after conversation or task preparation. Matching tasks retain their checked inputs, and known rejected photos are skipped before another review. Changed tasks, rules or review recipes remain eligible; technical failures do not become visual rejections.

Explicitly stopping a conversation cancels its accepted visual work and pending admissions. Closing a dialog or naturally completing a turn keeps background work active, and other Sessions and independent workbench tasks remain active. Saved results remain available. Preventing cancelled-job notices from waking an idle conversation also requires the matching AutoFlow host update. Restart after current tasks finish; saved profile data requires no migration.

## Visual Curator 0.2.5

Preview searches use bounded concurrent reviews and reuse prepared native reference attachments. Invalid output fields or evidence identities retain diagnostics and retry within the original task budget. Later searches skip confirmed mismatches only for the same task, frozen style and review recipe; technical failures and uncertain results remain eligible. Pause and continuation reuse completed reviews and preserve call and download budgets.

Restart after current tasks finish to activate the plugin update. Existing failed records do not trigger automatic paid retries. Hiding the task sidebar in narrow conversations requires the matching new desktop build.

## Visual Curator 0.2.3

The installed plugin list and workbench use the updated artwork. Existing styles, references, tasks and feature choices remain; restart after updating.

## Visual Curator 0.2.2

Native LLM timing applies to reference analysis, image-search reviews, crop proposals, evaluation and context compaction. These paths no longer have plugin-imposed request or task wall-clock deadlines, including continuation of saved native tasks. Native connection and idle handling, explicit cancellation, call/page/byte quotas and bounded retries remain effective. Image-source and image-download requests retain network timeouts; explicitly selected compatible HTTP tasks retain their existing limits.

When the task directory reports a newer status, the conversation card cancels its stale detail read and fetches the current result. A stalled or late running response cannot block terminal status or overwrite the refreshed view. Update the plugin and restart AutoFlow after current tasks finish. Saved data requires no migration; existing technical-failure records remain and are not automatically submitted as paid retries.

## Visual Curator 0.2.1

Native reference analysis uses the selected LLM adapter's timing instead of plugin request and task wall-clock deadlines, including continuation of failed tasks. Cancellation, native connection and idle handling, call counts and byte budgets remain active. Continuing retains saved observations; image downloads, search, crop and compatible HTTP requests keep their existing time limits.

Style summaries use short image labels, log their canonical dictionary and restore evidence identities before saving. The analysis dialog retains readable received content and a stable JSON view across bounded stream tails, preserving follow-to-latest and historical reading positions. Update the plugin and restart AutoFlow. Existing profile data requires no migration; live paid-model behavior on another computer remains to be tested.

## Visual Curator 0.2.0

Reference imports run in the background, retain committed images after interruption and resume remaining work. Completed searches can supply positive or negative references across tasks. Dataset export distinguishes complete style packages from role-specific observation packages, and search preparation includes current negative evidence and historical exclusions.

Search queries and visual reviews enforce subject prominence before accepting a style match. The workbench adds paginated, virtualized image lists, responsive conversation task cards and incremental analysis refreshes with current context usage. Repeated reference validation, dataset serialization and preview concurrency are reduced without removing authorization, checksums or per-image commits. Saved profile data remains in place; app-owned UI and native capabilities require the matching AutoFlow build, followed by restart.
