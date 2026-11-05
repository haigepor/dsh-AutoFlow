---
description: "Build branching style and image workflows on a persistent node canvas using the project's configured models."
kind: "package-bundle"
---

# Style Prompt

English | [中文](README.zh.md)

## Summary

Style Prompt provides a React Flow canvas for reference images, style analysis, rule selection, new scenes, bilingual prompts and image generation. It uses the profile's configured LLM providers and attachments. Image generation requires an explicitly registered image provider; image input support alone does not imply image output. The canvas and Codex Subscription integration use the matching AutoFlow Host build.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)
- [Model experience](#model-experience)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)
- [Dev note](#dev-note)

<a id="use-this-package"></a>
## Use this package

### Install into a profile

Style Prompt ships with the CLI and Desktop runtime. Enable it under **Plugins → Installed plugins**, then open **Style Prompt** from the sidebar. Existing profiles keep their saved feature choices. Build with `pnpm --filter dsh-plugin-style-prompt run build`; restart a profile after replacing JavaScript that it cannot hot-load. Independent release instructions live in the [release guide](release/README.md).

### Analyze and create prompts

1. Use the connected starter workflow or add nodes through **Add node**, the canvas context menu, or by dropping a connection onto empty space. Connections accept matching port types, reject cycles and allow multiple image sources.
2. Import PNG, JPEG, WebP or GIF references into a reference node. Imports are saved to the active profile; external models receive images only when you run a node. Choose a vision model and analysis dimensions on the analysis node.
3. Run the analysis, then select transferable rules. Unknown and scene-only observations cannot become style requirements. Enter the new scene and changes on the scene node.
4. Select a text model for three bilingual prompt variants, or choose quick composition and supply both languages. A generation uses the selected rules without repeating image analysis.
5. For images, select an advertised image model. The built-in Codex Subscription integration exposes its configured image catalog through `llm`; no separate ComfyUI server is required. Connect prompts or enter one directly. A connected prompt takes precedence, and its manual field is disabled. Connect image references explicitly when required.
6. Run selected nodes or the workflow. Select the scene, prompt, image and output nodes with Shift and use **Duplicate branch** to reuse the existing analysis with another scene. Unchanged ancestors are reused; explicitly targeted generation runs create new requests.
7. Preview results in nodes, inspect complete prompts and rule evidence, copy bilingual text, export prompt JSON/Markdown, download original images or export the canvas JSON.

Space-drag pans, the wheel zooms and Shift selects multiple nodes. Arrow keys move selected nodes; Delete removes selected nodes and links. Pointer and keyboard edits autosave and support undo and redo. Run inputs are frozen separately from the draft, so editing cannot redirect a late result. Validation locates the missing field and expands English inputs when required. Models are grouped by provider and searchable when the list is long; unavailable selections keep their identity and offer the application settings entry. A failed branch blocks its descendants while independent branches continue. Stopping drains local work; a dispatched request may still complete remotely and is not automatically resent.

Canvas edits, node sizes and the viewport autosave with revision checks. A failed save retains the draft with a retry action. A conflicting save offers **Save as new canvas** or **Reload saved canvas**. Transient operation results use the application Toast; persistent save errors, model-catalog failures and missing inputs stay visible beside their owning canvas or node. Deleting canvases or retained records requires a confirmation that states which data is removed.

### History and deployment limits

**More actions → Runs and history** opens read-only run snapshots without a persistent bottom bar. Return to the current draft to edit, or save a snapshot as a new canvas. Running a snapshot's node explicitly runs that node in the current draft. Other canvases continue running in the background, and their menu and completion notices return to the owning canvas. The original analysis and prompt history remains in its original storage domain. **Open as canvas** creates an additive graph referencing successful history; it does not rewrite or delete the old records. Existing JSON and Markdown prompt exports retain their format. Referenced tasks cannot be deleted while retained canvases or runs own them.

[Config](src/host/config.ts) bounds images, request and response bytes, task concurrency, deadlines, stored tasks, canvases, assets and runs. Defaults allow four images of up to 8 MiB each, 32 MiB per upload, 180-second text work and 600-second image work. Canvas JSON import and export share a default 16 MiB file limit, bounded by the request byte limit. **More actions → Reference assets** shows asset usage and explicitly cleans unused entries. Saved canvases, retained run snapshots and imports from the last 15 minutes are protected; save drafts in other windows before cleanup. Cleanup releases plugin asset slots without deleting application attachments. Canvas exports include a reference hash manifest, without embedded pixels or credentials. Import matching images into the destination profile before importing its canvas; import remaps the image references and clears task identities from the source profile. The canvas JSON is this plugin's document format, not a ComfyUI executable workflow.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details</summary>

[Canvas documents](src/shared/canvas.ts) separate editable parameters and layout from immutable run snapshots. [Validation](src/shared/canvas-validation.ts) is shared by Client preflight and Host execution. [CanvasService](src/host/canvas-service.ts) owns dependency ordering, branch isolation, input-based reuse, cancellation and restart recovery. It delegates text analysis and prompt generation to the existing [task service](src/host/service.ts), and images to the public LLM image provider. Originals and normalized previews remain separate attachments.

The additive canvas domain uses the existing profile writer lease. Legacy task records and their format version stay unchanged. Restarted active runs become interrupted without dispatch. Canvas results retain the exact submitted image prompt and reference metadata. Client teardown stops subscriptions; Host teardown drains graph work before closing legacy storage.

The Client bundles React Flow privately and resolves React, ReactDOM, the JSX runtime and UI primitives from the Host module table. Controls use the project's Menu, Input, Button, TextArea, Checkbox, Tooltip, ZoomControls, StateDot, AnimatedCollapse and Toast. CSS inherits application typography, radii, surfaces and semantic state colors. Third-party notices are distributed with the bundle.

</details>

<a id="further-exploration"></a>
## Further exploration

- [Custom bundle architecture](../../architecture.md)
- [Prompt-source research](../../docs/research/2026-10-28-image-style-prompt.md)
- [Task integration tests](tests/native.test.ts)
- [Canvas execution tests](tests/canvas.test.ts)

<a id="model-experience"></a>
## Model experience

Nodes explicitly initiate auxiliary LLM operations; the plugin installs no global instruction, Skill or Agent tool. Analysis sends native image attachments with bounded structured-output instructions. Prompt generation sends selected rules, source exclusions and the new scene as text. Quick composition, graph edits and exports do not call a model. Image generation sends the frozen prompt and explicitly connected reference attachments through the configured provider. The main conversation and Session format are unchanged.

<a id="known-limitations-and-deferred-work"></a>
## Known limitations and deferred work

Style extraction and prompt validation cannot guarantee semantic accuracy or final-image quality. Generation providers must implement the public LLM image API; a conversational model is not automatically an image generator. This package does not execute diffusion locally or import native ComfyUI workflow JSON. Paid-provider output quality requires separate real-service evaluation; deterministic test images are only fixtures. Cross-profile canvas transfers require restoring referenced image attachments. Multi-analysis style blending is not supported: each prompt consumes one analysis and its selected rules.

<a id="dev-note"></a>
## Dev note

None.
