---
description: "Develop maintained, independently versioned DSH plugin bundles."
kind: "package-group"
---

# Maintained plugin workspace

English | [中文](README.zh.md)

## Summary

Create one formally maintained plugin bundle in each direct child directory. Each child is an independent npm package; this directory is only a source-area organizer and is not a pnpm workspace or a package to publish.

## Structure

- `<plugin-name>/`: one independently versioned npm bundle, including its package manifest, patch, Host and optional Client entries, assets, tests, and README.
- `../demo/`: the runnable reference to copy before replacing its identity, UI copy, feature declarations, and managed-content markers.

Use lowercase kebab-case directory names that match the unscoped part of the npm package where practical. Keep every plugin's package-specific documentation, tests, and release notes in that plugin's own directory. Shared rules belong in the [parent architecture guide](../architecture.md).

## Dev Note

None.
