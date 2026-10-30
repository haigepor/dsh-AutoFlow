---
description: "Develop and distribute independently versioned DSH plugin bundles."
kind: "package-group"
---

# Custom plugin bundles

English | [中文](README.zh.md)

Independent product versions, formal Release assets and historical tag retention follow the [release governance guide](release-governance/README.md).

## Summary

Develop maintained plugin bundles under `workspace/`, with independently versioned npm packages. Installation-supplied bundles are declared in the [CLI production dependencies](../apps/cli/package.json) and packed into Desktop's runtime; profiles select their own enabled bundles. This directory organizes plugin sources and is not a package to publish. Read the [architecture guide](architecture.md) before changing rows or file ownership.

## Table of Contents

- [Packages](#packages)
- [Structure](#structure)
- [Dev Note](#dev-note)

## Packages

- [Better Sidebar](workspace/dsh-better-sidebar/README.md): the upstream snapshot and native-sidebar registrations.
- [Sidebar updater](workspace/dsh-better-sidebar/updater/README.md): independent official version checks and npm updates.

- [AFP curation](workspace/dsh-plugin-afp/README.md): photo search, visual curation, and local installation steps.
- [AFP releases](workspace/dsh-plugin-afp/release/README.md): versioned GitHub artifacts and the reusable release procedure.
- [Visual Curator](workspace/dsh-plugin-visual-curator/README.md): versioned styles, human feedback, image search and reviewed crops, carried with the application.
- [Style Prompt](workspace/dsh-plugin-style-prompt/README.md): installation-supplied reference-style analysis through configured APIs and differentiated prompts for manual image generation.
- [Architecture](architecture.md): package layout, feature declarations, UI placement, file lifecycle, and distribution rules.

## Structure

Each `workspace/<plugin-name>/` contains its package manifest, patch, Host and optional Client entries, assets, tests, and README. Use lowercase kebab-case directory names that match the unscoped part of the npm package where practical. Keep package-specific documentation, tests, and release notes in that plugin's directory; the architecture guide owns shared rules.

## Dev Note

None.
