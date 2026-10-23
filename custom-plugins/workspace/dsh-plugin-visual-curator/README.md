---
description: "An optional DSH profile layer for versioned visual styles, image search, reviewed crops and auditable human labels."
kind: "package-bundle"
---

# dsh-plugin-visual-curator

English | [中文](README.zh.md)

## Summary

Build a visual style from selected reference dimensions, publish immutable versions, and use one fixed standard for image search and actual-image crop review. Human corrections remain auditable and affect future standards only after explicit publication. DSH carries this independent bundle with its installation and enables its eight Agent tools in newly initialized Web and Desktop profiles. Existing profiles retain their choices. Local records remain available without search or vision configuration, while operations that need those services fail visibly until configured.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Enable the profile layer

In Plugin Manager, enable **Visual Curator** to use the installation-owned copy in an existing profile; no profile-local package installation is required. Restart an already running Host after updating the application's installation dependencies. An installation that does not carry this bundle can install a reviewed package artifact into the intended profile instead. Its [patch](cordis.patch.yml) mounts the business provider, six Skills, three Agent tool groups and three page entries, each with an independent switch. Skills register through the native catalog without writing Home files. The Host must provide profile context, storage domains, credentials, jobs, Plugin Manager, configuration editing, the skill catalog and Session storage. The Web client uses the standard Plugin Manager detail page. The package provides no application executable; launch applications through a supported `dsh` profile.

This bundle does not add itself to other profiles or change AFP. Turning it off removes its registrations, stops new work, cancels and drains active work, and retains saved data. A second Host writer for the same profile is refused; stop the first Host before reopening the writer.

### Configure external services

Configure the provider row in the owning profile's Cordis overlay. `source` describes one HTTP JSON image source, including endpoint, method, query/cursor/page-size fields, response JSON Pointers and allowed media origins. `vision` names a compatible multi-image JSON model and endpoint. `limits` controls file/decode/storage limits, request and candidate budgets, retries, concurrency and deadlines. The [configuration parser](src/host/config.ts) owns accepted fields and defaults; configuration is resolved before the task snapshot is created.

`source.endpoint`, optional `source.lookupEndpoint` and `vision.endpoint` reject embedded credentials, query parameters and fragments. Set `source.allowedMediaOrigins` and `vision.localOrigin` to exact origins without paths or a trailing slash. The optional lookup endpoint refreshes media by its stable source ID; it does not restart an expired search from its first page.

`vision.vendorVersion` records the supplier's declared model version. Without that declaration, saved requests retain a replay limitation. Changes to model sampling, `limits.maxVisionOutputTokens`, `limits.maxReferenceImages` or `limits.maxReferenceBytes` produce a new reviewer identity. For formal search and crop tasks, create a new candidate and publish its release before using the changed review method. Existing releases retain their saved method.

Save secret values in DSH credentials. The plugin stores only credential references, initially `VISUAL_CURATOR_SOURCE_KEY` and `VISUAL_CURATOR_VISION_KEY`; changing a JSON field does not store a secret. Sources and media use bounded public HTTPS requests with redirect and DNS checks. An explicitly configured local vision origin is the supported exception for a local model. Arbitrary request scripts, model-supplied endpoints and remote collection writes are unavailable.

Budgets limit actual attempts, bytes and elapsed time. Retries spend the same task budget, and an interrupted external request retains its reserved quota because the provider may already have billed it. The implementation reports unknown cost; it does not enforce a currency-denominated spending cap or predict the final invoice.

### Establish a fixed style

The package detail page uses the same native layout as AFP: artwork, examples, description, grouped optional features and switches, with twelve features. Skills cover reference styles, calibration, style-guided search, crop composition, human feedback and dataset/Skill export. The tool groups are read tools, search/crop, and feedback/export. Together they still provide eight Agent tools; disabling a group removes only its registrations.

Settings sidebar, global panel and conversation tab entries are off by default. Enabling one displays a pending-design page; contents will be built incrementally with the new design. Entry state follows native plugin inventory changes and connection resets without polling. Hiding an entry does not delete data or stop tasks. The removed workbench is not mounted on the detail page. Saved data and authorized Host actions remain available; new human creation and review controls are not exposed by this detail page. The following sections describe the retained data operations.

1. Create a style and import JPEG, PNG or static WebP references. Select positive, negative or undecided intent and choose overall preference or specific dimensions. A color-only example does not label composition or subject. Mixed batches retain successful items and report rejected files individually.
2. Analyze references to obtain model observations and pending rule suggestions. Program measurements, model estimates and uncertainty remain separate. Confirm required rules, inspect support/counterexamples and resolve required conflicts in the draft.
3. Create a candidate and compare it when independent labels are available. Publish a provisional or evaluated release; evaluated records completion of the declared comparison, not an automatic quality target. Publication does not select a default. Choose or roll back the default explicitly.
4. Create an independent usage revision with an exact reduced ratio, matching output pixels, safe regions and protected content. Search and crop tasks use the selected release, usage, recipe, reference bytes and budgets throughout execution.

### Review results and corrections

Search results keep original and final assessments separate. Required failures cannot be offset by preference scores, and unknown or technical failures do not become aesthetic rejection labels. Only distinct qualified final images count toward the target; a short result set retains its actual stopping reason. A preview without sufficient original pixels cannot satisfy a final-output pixel requirement.

Manual cropping has two confirmations: complete the adjustment to save and review a real derivative, then explicitly allow its use as a learning example. Closing a preview, downloading, accepting a batch or abandoning a drag creates no ideal-crop label. A legal manually selected image with visual warnings remains distinct from an automatically qualified result. No crop is enlarged, stretched or expanded to satisfy an impossible request.

Feedback defaults to task-only. Opt into the current style candidate before a correction can contribute to its next draft; task irrelevance, “not needed” and unknown remain separate from style rejection. Revisions append a new feedback record and move one effective head. Old releases and exports retain their original records. Agent suggestions never become authenticated human confirmations.

Review-queue fields identify uncertain judgments, technical failures, human/model disagreements and new source groups awaiting human review. `limits.reviewSampleRate` also selects ordinary passed or rejected images reproducibly from their image digests. Each task fixes its sampling rate at launch. Queue membership changes no feedback or release, and a new source group does not imply a newly detected semantic category.

### Scope and recover work

Client-created profile tasks and Agent-created Session tasks have distinct owners. Authorized owner actions must open the owning Session channel before reading its tasks, pixels or exports. Saving a Session result to the profile library creates an independent association and leaves the original Session ownership intact.

Navigating away from Plugin Manager leaves work running. Pause and cancel stop admission and drain in-flight work before acknowledgment; committed results remain readable. After a Host restart, interrupted work needs explicit resume with the same saved settings and checkpoint. Missing resources, changed provider revisions or an invalid continuation cursor stop recovery with a visible error; a new search is a separate operation. Plugin shutdown cancels work instead of publishing late results.

### Split, compare and export

Confirm family membership before assigning learning, development or holdout groups. Original images, exact duplicates and their derivatives share a family. Unconfirmed similarity is not evidence of independent data; previously analyzed or calibrated families cannot become independent holdout data. Holdout images are excluded from induction and training exports; using revealed holdout errors to revise rules requires a new manifest with those families moved out of holdout.

Select related source groups and explicitly confirm their merge before reopening the split form. The merge saves immutable family aliases and membership confirmation while preserving the original asset records. Earlier splits whose groups now collide across sets cannot be used; create a new split with the combined group kept together.

Comparisons retain fixed release/candidate references, pixels, usage, feedback heads, raw counts and denominators. Recall includes every labeled positive, including review, technical-failure and unprocessed states; precision counts labeled qualified results. A zero denominator is unavailable. Budget exhaustion saves a partial report with every fixed input and an explicit outcome. Image-only comparison does not generate crops or establish crop-damage metrics; those metrics remain unavailable without the corresponding independent crop supervision. Comparison never changes a default release.

Exports support style packages, classification/preference/crop JSONL and Skill Markdown. A download is a versioned JSON envelope containing `files` with textual content/checksums and, only for an authorized with-bytes export, `resources` with media bytes encoded as Base64. File checksums are SHA-256 over exact UTF-8 content; business-record digests use separately versioned canonical JSON. References-only is the default. Image bytes require recorded permission and a successful integrity check; missing, corrupt or unauthorized bytes fail the export instead of producing a supposedly complete package.

Training exports include learning families only and retain the eligible human feedback IDs frozen at request time. Later corrections do not rewrite an existing snapshot. Preference ties and neither choices remain explicit. Generated Skills identify the release and required resources, require a missing-resource report when pixels are unavailable, and only produce downloadable artifacts. They do not modify Home instructions, activate in a Session, train a model or contain model weights.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One Host provider owns authorization, explicit input resolution and workflow dispatch. The storage-domain repository writes immutable dependencies before replacing one aggregate manifest; only manifest-referenced records are visible. Expected revisions serialize edits, operation IDs recover completed commits, and a profile filesystem lock prevents a second Host from opening a competing cache. Unreferenced files or records left by a failed commit remain private.

The [domain](src/domain/index.ts) owns style versions, effective feedback, splits, evaluations and export snapshots; [media processing](src/media/index.ts) owns verified bytes, geometry and bounded external adapters. The [runtime](src/host/runtime.ts) separates durable tasks and attempts from process-local jobs. The [client](src/client/index.ts) and [Agent tools](src/host/tools.ts) call the same provider; the bundle patch changes no agent loop or Session event format.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

See [custom bundle architecture](../../architecture.md) for installation/composition, [storage domains](../../../packages/storage/storage-domain/README.md) for durable writes, [jobs](../../../packages/jobs/jobs/README.md) for in-process execution, and the [approved change](../../../openspec/changes/add-visual-curator-v1/design.md) for the acceptance requirements.

-----

<a id="model-experience"></a>
## Model Experience

The optional tools row exposes bounded style reads, search/crop starts, run reads, Agent suggestions and export starts/reads. It exposes no human-confirmation, publication, default-switching or split-confirmation command. Long operations return task handles; a start acknowledgment is not a qualified-image result. Tool results contain safe identifiers and authorized resource references; auxiliary vision requests retain their actual image order, digests, prompts, model/version declaration and validated output.

Tool declarations add to the model's tool-schema context while enabled. The bundle does not inject a style into every request or change Home instructions. Individual vision calls consume their own text and image budget; cached-prefix behavior and exact vendor token charges depend on the configured provider and are not measured here.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Only the configured HTTP JSON source and compatible multi-image vision protocol are supported. There is no arbitrary-site crawler, paid-original acquisition, image generation, segmentation, embedding/vector retrieval, model training or remote favorite write. The system reviews currently recalled candidates and cannot claim complete-library recall. Original quality, licensing, export permission and aesthetic usefulness require the user's own verification.

Keyless fixtures validate control flow and exact image geometry. They do not validate a real source/model deployment, vendor billing, broad visual quality or suitability of a user's references. Supply actual endpoints, response mappings, credential references, model capabilities and authorized samples before treating those properties as verified. Image-only evaluation leaves unsupported crop metrics unavailable. Profile locking coordinates processes on one machine; shared storage across independent hosts is outside its supported locking model.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
