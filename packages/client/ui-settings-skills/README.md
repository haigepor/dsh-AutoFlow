---
description: "Manage global and project skills from native settings cards, quick previews and complete instruction details."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-skills

English | [中文](README.zh.md)

## Summary

Open Settings → Skills to manage global and project instructions, import files or bundles, subscribe to public GitHub repositories, browse skills.sh and ClawHub, and recover retained backups. The compact introduction shares MCP's dimensions and uses its book-reading companion mascot. Cards and loading placeholders share a responsive three-column grid. Selecting a card opens complete instructions, directories and source information in one tabbed modal. Instructions render as Markdown; editing exposes the full source. Status and category filters retain visible field labels.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

New skill opens a workspace and model dialog. Continuing creates a fresh conversation, saves the chosen model and prepares an editable `/skill-creator` draft through the existing conversation service. The user adds requirements and sends the message. Import accepts native file or folder selection behind shared buttons, shows selected files and keeps its explicit destination and overwrite choice.

Discovery separates public catalog search from GitHub repository browsing and subscriptions, with one visible workspace context and installation target. Source directories are grouped by local, bundled and external ownership, with exact paths and access labels. Registration changes do not move files. Selector anchors fill their labelled fields so portaled menus measure the same width as the button. Skill details keep identity, navigation and actions outside the scrollable reading pane and limit Markdown line length.

Writes use explicit destinations and revision checks. Repository updates require an exact preview token and retain the previous bundle. Backups remain in the current profile skills-manager directory until explicitly removed. maxBytes, maxFiles and requestTimeoutMs bound uploads and downloads. Sources and classification are stored independently of skill Markdown.

## Model Experience

None, as the management UI registers no model-facing tools or catalogs and only edits stored instruction files and registry state.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

- Online discovery requires available external services.
- Management covers locally readable sources and does not map remote workspace paths onto Host directories.
- Backups are not automatically pruned.

### Dev Note

None.
