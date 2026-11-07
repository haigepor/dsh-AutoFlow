---
kind: upgrade-guide
description: Visual Curator wallpaper records require the updated plugin reader after new composition derivatives have been saved.
---

# Visual Curator wallpaper data

English | [中文](guide.zh.md)

## Change

The wallpaper workflow adds the `composition` image-version discriminator, wallpaper processing metadata and versioned Run checkpoints. Existing images, analyses, exports and three-node layouts remain readable by the updated plugin. Older plugin readers do not understand the new derivatives; downgrade is unsupported after wallpaper work writes them. No Session-format or model-weight migration occurs.

Recoverable masked outpainting also requires the matching native LLM task interface and Codex Subscription adapter. Importing Visual Curator alone into an old desktop does not add those capabilities. Pure crop processing remains available; images needing extension stop with a capability notice.

New tasks also save the prompt tags `wallpaper-plan-v2` and `wallpaper-outpaint-v3` and the composition mode `protected-context-v2`. Updated readers preserve legacy task prompts and generation receipts; older readers do not support these new tags. Recomposition reuses an existing generation and cannot claim a different generation mask. Explicit manual corrections preserve cumulative edit limits.

## Migration

1. Back up the stopped Profile data directory before local testing. Keep the backup separate from the live writer.
2. Use the matching source desktop and the updated Visual Curator and Codex Subscription packages for masked wallpaper work. The [local workflow](../../../../custom-plugins/workspace/dsh-plugin-visual-curator/README.md#wallpaper-workflow) defines entry points and commands.
3. Open a saved search batch, start wallpaper work and confirm the downstream nodes expose actual plans, outputs and review receipts. Existing datasets and preview searches remain available.
4. To return to an older plugin after new wallpaper records exist, stop the Profile and restore its pre-test data backup together with the older package. Do not delete or rewrite individual manifests to make an old reader load.
