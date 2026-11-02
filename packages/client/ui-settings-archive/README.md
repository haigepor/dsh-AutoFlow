---
description: "Settings page for archived and unarchived sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-archive

English | [中文](README.zh.md)

## Summary

This plugin contributes **Archived sessions** to Settings. Users can find sessions by title, Workspace, update date and favorites, archive or restore individual sessions or a selection, and restore a session before opening its conversation. It uses the existing Session catalog, Workspace archive set and navigation service, and shared settings document.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

The Web bundle composes this plugin for both Web and Desktop. Its settings section is `archived-sessions`; it registers only while the peer may follow Workspaces. The page initially shows archived sessions. Subagent-origin and blank sessions are excluded. Switching tabs or filters clears the selection; collapsing a group does not change it. Select current results includes matching rows inside collapsed groups. Date filters use the last update, include both endpoints in the browser's local time, and support presets and custom ranges. Sorting uses the update time or title; the Host archive set supplies no archive timestamps.

Favorites are independent of sidebar pins and persist in the Host settings namespace `ui-settings-archive` as `favoriteSessionIds`. Archiving and restoring preserve favorites. Writes carry the namespace revision; a conflicting write reloads accepted preferences instead of overwriting another client's changes. Restore preserves the recorded Workspace position. Restore and open navigates only after restoration succeeds and does not override a later navigation. Archive requests never stop running work: known running sessions or sessions awaiting input cannot be selected for batch archiving, and Host admission still checks every request. Background work discovered by the Host produces a per-session refusal with a retry action.

Batch requests run serially, continue after individual failures, and report unfinished items for explicit retry. A batch continues when Settings closes, with feedback rendered in `shell.overlay`. Disposing the plugin stops subsequent dispatches; an already sent Host request can still finish. The page opens no cold session logs for filtering.

The Archived tab offers single and batch permanent deletion after confirmation. The Host rejects unarchived sessions, active work and foreign write ownership. Deletion removes the selected session records, projection checkpoints, search rows, Workspace membership, pins and favorites; Workspace files and other sessions remain. Partial cleanup offers an explicit retry. Selected rows use a primary-color tint, and groups use the shared `AnimatedCollapse` primitive with theme motion tokens and reduced-motion support.

The deletion dialog shows completed and total targets, a progress bar and a running indicator while requests settle. Committed record removal leaves the Session catalog before secondary cleanup; failed cleanup remains available for retry without returning the deleted row.

## Understand the implementation

`src/client/index.ts` owns registrations and injected commands. `ArchivePage.tsx` receives standard Session and Workspace hooks and a narrow operation source. `operations.ts` owns batch progress, item failures and transient notices. Authoritative session and Workspace data remains with the existing API controllers. Controls come from ui-primitives; CSS uses the shared theme tokens. The decorative archive illustration is a transparent sibling of the project's whale maid artwork.

## Model Experience

None, as the page registers no model tools, prompts, events or messages and its archive, restore and favorite controls make no model requests.

#### KV Cache effect

None. The page does not change model input or cached conversation content.

## Known Limitations and Deferred Work

- Search covers titles; full-text search, read-only archived previews, idle cleanup and cross-Workspace moves are outside this page's operation set.
- Archived sessions must be restored before the existing conversation navigation can open them. The current archive model has no per-session archive time.

### Dev Note

None.
