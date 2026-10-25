---
kind: upgrade-guide
description: "Visual Curator gallery references store remote URL records that older plugin builds cannot read."
---

# Visual Curator gallery references use remote URLs

English | [中文](guide.zh.md)

## Change

Gallery views register public preview links instead of downloading and normalizing every selected image. New image versions use `remote-reference` and a `remote-url-v1` descriptor digest. Older plugin builds cannot read these new records. Existing byte imports and original-path references remain readable without conversion.

The vision API receives remote `image_url` inputs. Its service must be able to fetch the approved Unsplash CDN links. Remote references cannot establish local byte checksums, measured dimensions or byte-for-byte replay. Reference datasets include the URLs and this limitation; cropping and byte exports require byte-backed images.

Successful account checks are reused for `source.unsplash.identityCacheTtlMs`, which defaults to 180000 milliseconds. Explicit refresh, credential changes and authentication failures require a new check. Byte imports retain fresh validation.

Reference tasks belong to the Host and remain observable after closing the dialog or reloading the page. Host restart marks unfinished tasks interrupted without automatic replay. New task manifests do not convert existing assets or Session records. Before downgrading, stop referencing, wait for final receipts and retain a complete data-directory backup.

New analysis tasks retain automatic-resume intent, bounded process messages and frozen defaults. New tasks use high reasoning and request streaming unless configured otherwise; existing saved specs retain their original parameters. System interruption resumes only opted-in analyses, while explicit cancellation and legacy cancelled runs remain stopped. Older plugin parsers cannot read the additional task fields; retain a matching data backup when downgrading.

## Migration

1. Back up the profile's `~/.dsh/profiles/<profile>/visual-curator` directory before creating remote references if rollback to an older plugin is required. Update the plugin and restart the existing Host to load its backend. No conversion is required for existing images.
2. If the deployment requires an account check for every request, set `config.source.unsplash.identityCacheTtlMs: 0` on its `visual-curator` profile row. Keep separate account descriptors and credential references.
3. Reference a collection and confirm that the dialog reports per-item progress and offers Cancel referencing. Cancellation retains the successful prefix. Confirm that an analysis request sends the remote URL to the configured model service and that its reference package includes `remoteSource` with `pixelDigest: null`.
4. Keep the updated plugin after creating these records. To restore an older build, restore the matching directory backup as well; do not remove fields or rewrite remote records into local pixel records.

5. Confirm that changing reasoning while a collection analyzes leaves its task on the original level. Start another collection, cancel one, and restart the Host: only the interrupted opted-in analysis continues, retaining its completed observations. Provider default remains available if high or streaming is unsupported.
