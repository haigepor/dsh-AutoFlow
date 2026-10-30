---
kind: upgrade-guide
description: "AutoFlow GitHub release updates move to updateBundleRelease while updateBundle handles registry versions."
---

# Use the release-specific update method

English | [中文](guide.zh.md)

## Change

AutoFlow's Plugin Manager method `updateBundle(name)` previously checked and installed a bundle's declared GitHub release. That operation is now `updateBundleRelease(name)`. The official `updateBundle(name, version, options)` updates an eligible registry package to an exact newer version and returns its installation and optional restoration results. Custom clients calling the former one-argument method must migrate. Bundle update sources, automatic-update permissions, activation choices and pending-restart state remain unchanged.

## Migration

1. Replace one-argument GitHub release calls with `pluginManager.updateBundleRelease(name)` and retain handling of its `ChangeResult` and restart requirement.
2. Use `listVersions` followed by `updateBundle(name, version, options)` for registry updates. Inspect both `result` and any `restore` result before reporting success.
3. Rebuild Remote declarations and the client. Verify a declared GitHub release retains its activation and requires restart, and that registry updates retain their version selection and restoration feedback.
