## Context

The MCP client owns connection generations and tool disposal. The agent loop assembles tools before each step. Settings navigation uses registered sections; profile configuration and plugin enablement already have serialized owners.

## Goals / Non-Goals

Goals: manage profile-owned stdio and HTTP servers; expose actual connection state; preserve hidden credentials and raw expressions; apply changes to existing sessions; provide server and application restart actions.

Non-goals: install arbitrary server packages, modify agent-loop behavior, change Session formats, redesign existing pages, or manage ACP-owned server declarations as profile entries.

## Decisions

- An optional MCP connection registry remains owned by the MCP package. Each client registers its connection under its actual Fiber identity; UI status follows connection state rather than plugin activation.
- A dedicated MCP manager package owns Host management operations; the settings package owns the Client page. This follows the repository's Client dependency policy while reusing configuration editing, plugin enablement, Remote contributions, shared primitives, typed dictionaries, and existing theme tokens.
- The profile patch is the sole persisted source. New entry creation and inactive edits use the configuration owner with validation, locking, override checks, atomic writes, and rollback on failed reconciliation. Inherited or externally managed rows report restricted operations.
- Secrets are omitted from responses. Existing secret values use explicit preserve markers during edits; expressions survive unchanged fields. Writes detect stale detail revisions.
- Server restarts unload and reload only the selected connection. Existing conversations keep their identity and history and observe new schemas on later steps. Already issued requests are not retroactively changed; affected in-flight MCP calls fail explicitly during teardown.
- Application restart uses the owning launcher, process generation checks, and existing Desktop quit confirmation. Web configuration restart is separately authorized from plugin-upgrade restart.
- The MCP section hides the shared configuration-file footer. Its introduction follows the models page: the existing mascot artwork sits left of a short heading and guidance. Models and MCP use the same click-open FieldHelp, menu material, dismissal, and focus behavior.
- Transport selection uses the shared Menu and advanced fields use AnimatedCollapse. Structural loading placeholders use the skeleton theme token and respect reduced-motion preferences.
- The JSON dialog merges named declarations through the existing Host methods, retains editor-open revisions and null credential markers, and keeps draft text on failures. Imports validate JSON before writing; each server remains an independent write, so a failed batch reports partial progress. Source editing uses the shared Shiki highlighter and theme variables.

## Risks / Trade-offs

- Startup can complete while MCP discovery failed: expose saved and connection outcomes separately.
- Home/CLI overlays can override profile edits: reject ineffective changes and retain the prior file.
- Concurrent editors can overwrite values: require the detail revision during edits.
- Full restart interrupts running tasks: require an explicit user action and retain Session history without promising automatic replay.

## Scope and rollback

Allowed paths are the new MCP settings package; MCP client connection tracking and its tests; configuration-editor insertion/inactive-edit support; generic restart support and tests; settings navigation; Remote assembly; Web composition and dependency/build manifests; MCP documentation; focused UI/session tests; and this OpenSpec change. Existing unrelated working-tree changes remain untouched. Rollback removes the new composition entries and reverts only this task's edits; persisted MCP entries retain the existing client configuration format.
