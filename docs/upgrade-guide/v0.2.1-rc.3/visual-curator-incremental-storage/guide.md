---
kind: upgrade-guide
description: "Visual Curator adds an authoritative incremental storage unit that older plugin versions cannot read."
---

# Visual Curator incremental storage

English | [中文](guide.zh.md)

## Change

Visual Curator retains its existing `visual_curator_<profile-hash>` domain as a read-only base and writes new records through the storage facility to `visual_curator_<profile-hash>_delta_v1`, using the existing per-record layout. Existing records and commit manifests keep their formats. No original data is moved or deleted. A saved checksum binds the incremental unit to its base; a changed base causes startup to reject the combination.

Backups must include both units. Older plugin versions see only the base and cannot read incremental writes. This does not change Session logs or either SDK.

## Migration

1. Stop the running profile and back up its Visual Curator storage. For the JSON backend, retain the original `visual_curator_<profile-hash>.json` file and any matching `visual_curator_<profile-hash>_delta_v1` directory together.
2. Update the plugin and restart the supported `dsh` profile. The incremental unit is initialized automatically; no bulk copy is required. If storage domains use explicit backend routes, route the additional unit to a supported KV backend as well.
3. Confirm that existing collections, references and analysis results remain visible. Create a collection, restart the profile and confirm it remains present. New writes leave the base file unchanged.
4. Keep backing up both units from the same stopped profile. Do not delete the base, discard the incremental directory, or use an older plugin to write to the base. If startup reports a changed base, restore the matching two-part backup; do not merge files manually.
