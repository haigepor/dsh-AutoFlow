---
description: "Develop and distribute independently versioned DSH plugin bundles."
kind: "package-group"
---

# Custom plugin bundles

English | [中文](README.zh.md)

## Summary

Develop maintained plugin bundles under `workspace/`, with one independently versioned npm package per direct child directory. AFP is explicitly included in the repository pnpm workspace and shipped with Web/Desktop; other children remain separately installed packages. This directory organizes plugin sources and is not a package to publish. Read the [architecture guide](architecture.md) before changing rows or file ownership.

## Table of Contents

- [Packages](#packages)
- [Structure](#structure)
- [Dev Note](#dev-note)

## Packages

- [AFP curation](workspace/dsh-plugin-afp/README.md): photo search, visual curation, and local installation steps.
- [AFP releases](workspace/dsh-plugin-afp/release/README.md): versioned GitHub artifacts and the reusable release procedure.
- [Architecture](architecture.md): package layout, feature declarations, UI placement, file lifecycle, and distribution rules.

## Structure

Each `workspace/<plugin-name>/` contains its package manifest, patch, Host and optional Client entries, assets, tests, and README. Use lowercase kebab-case directory names that match the unscoped part of the npm package where practical. Keep package-specific documentation, tests, and release notes in that plugin's directory; the architecture guide owns shared rules.

## Dev Note

None.
