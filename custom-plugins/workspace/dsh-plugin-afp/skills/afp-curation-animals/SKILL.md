---
name: afp-curation-animals
description: Use DSH AFP tools for animal curation; inspect dry-run reports before any confirmed private-collection write.
---

# Animal curation

## DSH workflow

1. Call afp_status to check configured credential references. Never print credentials, signed URLs or image bytes.
2. Use afp_search_plan for offline query planning and afp_collections to verify exact private collection targets.
3. Call afp_refresh with categories=["animals"] for a visual dry-run. Save its runId; use job_output for progress, job_kill to stop and afp_report for the retained report. Resume using the same runId.
4. Metadata only recalls candidates; acceptance requires pixels, category hard gates and account-wide deduplication. Never weaken quality gates to fill a quota.
5. For remote changes, call afp_plan_change with append, replace or clear. Show exact collection names, removals and additions to the user. Call afp_apply only after explicit authorization and the DSH approval prompt.
6. A failed or cancelled write may be partial. Read afp_report and afp_collections, then create a new plan; never automatically retry or roll back.

Optional features can be disabled independently. If a required tool is unavailable, explain which capability must be enabled; do not launch scripts from an external repository.

## Visual acceptance contract

### Pollution feedback carried into the next search

Recent continuation batches exposed recurring false positives from podiums and meetings, hockey and red-carpet events, yoga or police scenes, museum sculptures/murals, human anatomical subjects, rocket launches, staircases, and staged studio portraits. Treat these as hard metadata and pixel-level exclusions; an animal keyword in the caption never overrides them. Keep recall diverse by rotating breed, charismatic-wildlife, bird, action, habitat, and natural-light variants instead of widening a single generic query.

Keep an image only when every condition passes:

- `bodyCoverage` is `full-body` or `near-full-body`; reject face-only, eye-only, nose-only, head-only, close-up, and important-body-part crops.
- `subjectRole=primary`; reject `secondary`, `background`, or `ambiguous` animals that are too small, incidental, behind a person/object, or not the immediate visual focal point.
- `imageClarity=clear`; fur, feathers, skin, scales, and other texture details must be readable.
- `graphicContent=none`; reject blood, corpses, wounds, gore, shocking, or uncomfortable content.
- `welfareState=natural`; reject restraint, cages, obvious fear/distress, forced interaction, or heavy staging.
- `environment=clean-natural`; reject people-dominant scenes, cages, fences, wire mesh, dirty settings, or artificial surroundings that overpower the animal.
- `animalClass=mammal` or `bird`; reject fish, reptiles, amphibians, insects, spiders, worms, mollusks, crustaceans, and other invertebrates.
- `coatColor=not-black-cat`; black cats are always rejected.
- `comfortLevel=comfortable`; reject spiders, arachnids, worm-like animals, larvae, disturbing macro insects, dense clusters, mating, mucus-heavy frames, and uncomfortable predation.
- `appealTier=high` or `medium`; low appeal is rejected for this people-loved collection.
- `interactionState=peaceful` or `neutral`; reject hunting, catching, carrying prey, biting, attacking, killing, and visibly threatening interactions.
- `occlusionLevel=none` or `minor`; reject leaves, other animals, foreground blur, water, or darkness hiding important body parts.
- `groupDensity=single` or `small-group`; reject dense colonies, crowded herds, and mixed-species scenes without one clear primary subject.
- `foregroundClarity=clear`; reject blurred foreground animals or scenes where multiple subjects compete for the focal point.
- `compositionQuality=balanced` and `aestheticScore>=4`; reject busy, awkward, visually harsh, or weakly composed frames.
- Search labels such as breed, habitat, season, action, and lighting are recall hints only; the model must verify the real visible animal and anatomy from pixels and must not promote a caption-only match.
- The animal is the primary visual subject and is not merely a background detail, sign, logo, toy, mascot, costume, or illustration.

The vision response must include all sixteen animal fields on every decision, including `subjectRole`. Use `unknown` when a field cannot be established from pixels; never infer a field from the caption, title, filename, or metadata. When any field is unclear, return `keep=false` rather than weakening the rule to fill a quota.
