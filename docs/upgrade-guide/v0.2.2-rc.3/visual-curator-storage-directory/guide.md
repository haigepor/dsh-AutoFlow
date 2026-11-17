---
kind: upgrade-guide
description: Visual Curator custom image directories require a plugin that reads the saved storage location.
---

# Visual Curator image directory

English | [中文](guide.zh.md)

## Change

Visual Curator can store image blobs outside the profile’s `visual-curator` directory. The profile retains the storage location and migration journal in `image-storage-location:v1`; image records keep their relative paths. Older plugin versions do not read this location and cannot access a migrated library. Profiles that keep the default directory need no migration.

## Migration

1. Finish or stop active image tasks. Open **Image storage**, choose an empty local directory, review the destination and start migration. Keep both source and destination drives connected.
2. The background job copies images, verifies their SHA-256 digests, commits the new location and removes verified old copies. The dialog may be closed. After an interrupted shutdown, restart the same profile to resume; use **Resume migration** for a reported failure after correcting the drive or file problem.
3. Confirm **Migration completed**, check the displayed directory and open a saved original and historical output. Task metadata and the profile writer lock remain in the original profile directory.
4. Before downgrading to a plugin without custom-directory support, use this dialog to migrate back to the profile’s original `visual-curator` directory and confirm completion. Do not manually edit the location manifest or delete either directory while a migration is pending.
