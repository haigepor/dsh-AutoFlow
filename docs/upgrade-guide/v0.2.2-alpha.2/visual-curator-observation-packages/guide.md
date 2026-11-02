---
kind: upgrade-guide
description: "Visual Curator role-filtered observation packages require an updated plugin reader and dataset client."
---

# Visual Curator observation packages

English | [中文](guide.zh.md)

## Change

Visual Curator can export positive-only or negative-only observations. These format 2 packages have a saved `sampleScope` and contain no executable style rules. They cannot be selected as a style-search dataset. Existing packages without `sampleScope` remain complete style-reference packages and are not rewritten.

Dataset list responses include `sampleScope` and positive, negative and undecided counts. Sample reads accept a `sampleRole` filter whose pagination token belongs to that filter. Older plugin readers do not support the new observation records.

## Migration

1. Finish active tasks, update the Visual Curator Host and client together, restart DSH, then refresh the page. No data-directory edits or reanalysis are required.
2. Update custom dataset clients to read the new counts and pass the same `sampleRole` on subsequent sample pages. Omitted export scope and sample filter retain the complete-package and all-sample behavior.
3. Generate a role-filtered package from the profile dialog and check its role counts. Use a complete reference package when starting style-guided image search. Keep the updated reader when opening saved observation packages.
