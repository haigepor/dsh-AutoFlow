---
description: "Extract reusable image styles through configured vision APIs and export new-scene prompts with manual reference guidance."
kind: "package-bundle"
---

# Style Prompt

English | [中文](README.zh.md)

## Summary

Style Prompt analyzes reference images with a vision model already configured in your DSH profile. Select transferable style rules, describe a new scene, and obtain bilingual prompts, differentiated variants and a reference-image plan. The workbench saves analysis and prompt history. You upload the reference images and prompts to your image generator manually; this bundle performs no image generation or model training.

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

### Install into a profile

Style Prompt ships with the CLI and Desktop runtime and appears under **Plugins → Installed plugins** with its own switch. New Web/Desktop profiles enable it by default; existing profiles keep their saved choices and can enable it on the Plugins page without installing an archive. Open **Style Prompt** from the sidebar after activation.

Build this workspace with `pnpm --filter dsh-plugin-style-prompt run build`. The package publishes `index.js`, `client.js`, [cordis.patch.yml](cordis.patch.yml), display locales and artwork. Its independent bundle row is `style-prompt`; Desktop packaging includes its local tarball in the production dependency set. Profiles that do not hot-load changed JavaScript need a restart after replacing an installed build.

### Analyze and create prompts

1. Configure an image-capable model in the project's model settings. Select that model in this workbench; no second API key or endpoint is needed.
2. Drop local images into the import area or use **Choose images**, then choose analysis dimensions and select **Analyze style · API**. A valid batch replaces the current selection. Unsupported formats, empty files and batches exceeding profile limits are rejected together while preserving the previous selection. Importing only creates local previews; images are sent when analysis starts. The original subject, scene-specific relationships and uncertainty remain separate from reusable style rules.
3. Select the rules to preserve. Unknown and scene-only rules cannot become transferable style requirements.
4. Enter the new scene and the changes you want. **Generate 3 variants · API** makes one text-only request using the saved analysis and returns Chinese and English prompts. The optional English fields allow **Compose draft · no API call** without another model request.
5. Download JSON or Markdown. The JSON reference plan records image names, checksums, selected rules and the manual-upload requirement. It contains neither image bytes nor provider credentials. Upload your references to the image platform yourself.

History is profile-local and survives restart. Stopping or unloading the plugin aborts local API work. A sent request may still be billed; interrupted work is marked visibly and is never automatically resubmitted. Repeating an admission whose response was lost reuses its task ID while that workbench remains open. Delete dependent prompt records before deleting their analysis.

### Deployment configuration

The bundle row accepts the validated fields in [config.ts](src/host/config.ts). Limits cover image count and bytes, upload/request/output bytes, model timeout and output tokens, concurrency, stored task count, history page size and polling interval. Defaults admit four images, up to 8 MiB each and 32 MiB in total, with a 180-second task deadline and 8192 output tokens. Model routes are selected from the profile registry. A missing route, a text-only route, invalid JSON or a truncated response never becomes successful analysis. A full task history rejects new work until records are deleted or the limit is changed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host uses the public LLM, attachment and storage-domain services. Each task freezes its inputs and saves its exact auxiliary model instructions, text, attachment references and resolved call settings before dispatch. Usage and terminal metadata are retained separately from private reasoning. One profile writer lease prevents competing processes from modifying the same domain. Shutdown drains admitted work before releasing storage. A failed terminal write stops new admission and reports an independent diagnostic.

[Analysis instructions](src/shared/prompts.ts) separate content from transferable style; synthesis uses explicitly selected rules and the new brief. [Compilation and export](src/shared/compose.ts) reject absent, unknown or scene-only rule selections and do not invent backend strength controls. FLUX.2 exports use positive instructions rather than a negative-prompt API field. [The native workbench](src/client/workbench.tsx) uses the application's React runtime and UI primitives, with lifecycle-bound sidebar registration. Authenticated profile routes carry uploads, saved records and image previews.

The workbench follows Visual Curator's compact toolbar, main workspace, right-hand inspector and collapsible history. Reference images and prompt exports have separate tabs; model selection and style rules remain in the inspector. Analysis dimensions use shared Pill controls in two columns, with the long rendering option on its own final row. Check marks, a selection count and keyboard operation expose the state; running tasks lock the selection. It shares the application's Menu, SegmentedTabs, Button, Checkbox and theme tokens. The build embeds optimized artwork in the Client entry, so installed packages do not depend on workspace asset URLs.

A small [material-swatch illustration](assets/style-dimensions-v1.webp) decorates the dimension heading. The built-in image tool generated it from the saved [asset prompts](assets/style-dimensions-v1.prompt.txt); its WebP preserves alpha for light and dark surfaces.

Style rules appear as selectable cards. English descriptions and visible evidence stay in expandable details. Those details and history use the shared disclosure animation and respect reduced motion.

The image import area uses its own transparent [photo-tray artwork](assets/reference-import-v1.webp), generated with the built-in image tool using the saved [asset prompt](assets/reference-import-v1.prompt.txt). Drag feedback follows the active theme and clears when a drop or task admission ends the drag. File selection and drop handling share the active profile's format, count and byte checks.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Custom plugin architecture](../../architecture.md)
- [Prompt-source research](../../docs/research/2026-10-28-image-style-prompt.md)
- [API integration tests](tests/native.test.ts)

-----

<a id="model-experience"></a>
## Model Experience

The workbench makes explicit auxiliary API calls; it installs no global instructions, Skills or Agent tools. Analysis receives real native image attachments and bounded structured-output instructions. Variant generation receives the selected style rules, original-content exclusions and new brief as text. Quick composition and export make no model requests. Main conversation behavior and Session formats are unchanged.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Schema validation and rule-ID checks cannot establish semantic accuracy or guarantee that a generated image preserves the intended style while differing enough from the reference. Single-image style remains provisional. Different model connections can return different observations; invalid or incomplete output requires an explicit new task. The generic reference plan is descriptive data, not a provider API payload. Exported reference checksums identify the saved attachment bytes, which can differ from the original upload after native normalization. Paid-provider quality evaluation and automatic generation are outside the keyless test fixtures.

<a id="dev-note"></a>
## Dev Note

None.
