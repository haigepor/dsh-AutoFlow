---
description: "Manage skill copies through ctx.skillManagement. The Web bundle mounts the service beside the native registry. Inventory retains invalid and shadowed files; invocation policy excludes disabled copies without widening frontmatter permissions. Configured native directories remain authoritative. External directories are read-only. Project mutations require a registered local workspace."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-manager

English | [中文](README.zh.md)

## Summary

Manage skill copies through ctx.skillManagement. The Web bundle mounts the service beside the native registry. Inventory retains invalid and shadowed files; invocation policy excludes disabled copies without widening frontmatter permissions. Configured native directories remain authoritative. External directories are read-only. Project mutations require a registered local workspace.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Writes use explicit destinations and revision checks. Repository updates require an exact preview token and retain the previous bundle. Backups remain in the current profile skills-manager directory until explicitly removed. maxBytes, maxFiles and requestTimeoutMs bound uploads and downloads. Sources and classification are stored independently of skill Markdown.

Details include a directory listing bounded by maxFiles across files and directories. Listing reads names without executing scripts or following symbolic links; unreadable or truncated subtrees are explicitly marked incomplete. Flat Markdown skills list only their instruction file; runtime-only skills have no local members.

The package bundles a read-only, user-only `skill-creator` under assets. It is discoverable through the native registry and explicit `/skill-creator` invocation, without adding an entry to model-facing catalogs. The skill guides requirements, native Markdown authoring, resource organization and practical validation. The settings creation action prepares a draft; it does not send a model request.

## Model Experience

None, as the service registers no model-facing tools or catalogs and only manages stored skill copies and registry state.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

- Online discovery requires available external services.
- Management covers locally readable sources and does not map remote workspace paths onto Host directories.
- Backups are not automatically pruned.

### Dev Note

None.
