---
description: "Models settings and product-onboarding plugin for the dsh web client: provider rows, API-key management, model lists, and the DeepSeek first-run dialogs."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-models

English | [中文](README.zh.md)

Desktop product events use the optional [product analytics service](../product-analytics/README.md); ordinary Web interactions are excluded.

## Summary

`dsh-client-ui-settings-models` is the Models settings page of the dsh web client: users configure API keys (stored write-only under the profile's credential reference), edit each provider's model list, and hand-declare custom pi-ai routes, with a model-first directory, a Providers tab, and one modal editor at a time. The page joins the provider directory, the settings document, and the credential descriptions into one shared snapshot, so a row's state stays consistent across all three. It also walks first-run users through two ordered dialogs — a versioned preview notice and the conditional official-DeepSeek credential step.

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

Provider refreshes retain an open draft after a transport failure and expose retry without treating stale data as a fresh save baseline. Credential references are read in batches of at most 64; native environment or OAuth authentication stays distinct from a named page-managed key. The account provider exposes its directory read-only, since account model selection is managed by that adapter rather than this API-key form.

The page uses shared `SegmentedTabs`, `Input`, `Menu`, `Button`, and `Modal` primitives with semantic theme, radius, and elevation tokens. The 26px title uses weight 500; the layout follows the active light or dark theme.

Saving credentials or a custom provider preserves the selected model. The user can select an available model from the composer.

DeepSeek Account appears first and DeepSeek second in the provider list; third-party providers retain their directory order.

Open Models from Settings to browse model names and IDs, providers, input and reasoning capabilities, and context capacities. Search and provider filters share a framed catalog with compact rows; capacities show both a compact value and an exact token count. The decorative whale-maid header illustration follows the preset artwork and is embedded as a transparent WebP. Add model first selects a configured provider. Model editing opens a centered dialog grouped into identity, capacity/input, and reasoning settings, while preserving sibling records and hidden fields. Provider dialogs group identity, connection/authentication, and model catalogs; their character illustrations follow the same preset artwork. Dialogs size to content and scroll within the viewport. Configured arrays take precedence over installed catalogs; an empty pi-ai array inherits its installed catalog. Custom endpoints are queried only by the explicit discovery action in the provider editor.

The Providers tab shares the model catalog's illustrated heading, typography, and spacing. Cards group a bundled provider mark and route identity above the model count and credential facts, with configuration/removal actions in a separate footer. A transparent connection-block illustration decorates each card. Credential state does not claim network connectivity. The account catalog is read-only. OpenAI and Codex marks retain the original artwork in light mode and use the generated transparent white mark in dark mode; both follow the application's resolved color scheme, including system mode.

The ChatGPT subscription tab manages the optional [Codex subscription plugin](../../../custom-plugins/workspace/dsh-plugin-codex-subscription/README.md) through its Host actions. OpenAI handles browser login; the page accepts a complete callback URL when automatic completion is unavailable. Account cards show authorization, quota freshness, reset times, token expiry, and subscription expiry separately, with revision-checked enable, priority, credit-use, and removal controls. Successful account changes refresh both the model catalog and Providers tab before success feedback. The page holds safe account metadata only; credentials remain on the Host. A missing or disabled bundle offers its current availability and an explicit activation action when supported.

The directory skeleton reserves tabs, filters, and model rows during initial loading. A background refresh retains open drafts; errors offer Retry. The shared modal manages focus and Escape, and refuses dismissal during writes. Existing provider editors keep their scrolling form and pinned actions; narrow windows keep table overflow local.

A provider with a stored catalog error remains visible with its diagnostic and edit/delete actions. Add actions are offered only for registered settings namespaces, so an unavailable namespace cannot leave a button that opens no editor. A rejected save leaves the editor open and displays the Host diagnostic.

After Apply closes an editor, its saved status appears when the current provider, settings, and credential snapshot is ready. Opening any row's editor, adding a provider, and opening a removal confirmation wait for that refresh. A newly opened Models section, or one retrying after a page-load failure, waits for a ready snapshot before mounting editors. A background refresh preserves an open draft while its editor remains mounted; a failed page load or provider removal can close it.

Host configuration `credentialOnboarding` defaults to `true`. The Electron preload marker suppresses automatic credential onboarding and the Web welcome notice; Models settings and explicit API-key editing remain available. The [account plugin](../ui-settings-account/README.md#desktop-onboarding) owns the Desktop introduction. Other native shells can disable only the credential step with `credentialOnboarding: false`. Host publishes this public boolean through `webserver/index-inject`, and Client validates it before registering dialogs. It is page initialization data, not a durable completion marker.

### API keys

API-key inputs start empty and use `autocomplete="new-password"` to ask browsers not to autofill saved login passwords. A nonempty draft has the same eye control as masked conversation text: **Show secret** reveals the current input and **Hide secret** masks it. Changing or clearing the input masks it again. Stored credentials are never read into the input.

The primary field on an editor card is a single **API key** input — the page never asks for an environment-variable name. A typed key stores write-only through `credentials.set` under the profile's reference, deriving `<ROUTE>_API_KEY` when the profile has none, and the pi-ai profile records that derivation as `apiKeyEnv`, so `cordis.patch.yml` never carries a key value. Leaving a new pi-ai provider's key blank saves a reference-free profile and preserves provider-native authentication (for example the Bedrock credential chain or Vertex ADC). Provider cards label confirmed configured and missing credentials separately from unknown or provider-managed authentication. A successful Apply shows the shared theme-aware success toast without echoing secret material. Repeated saves restart its display lifetime; the notification dismisses automatically.

### Editing a provider

Focused model dialogs use the same 42px input controls, leading field icons, 13px labels, and click-open explanation bubbles as the provider setup page. Model ID, display name, context, output capacity, input types, and reasoning guidance stay beside their fields. Basic information, capacity and input, and reasoning remain separate groups; narrow windows stack the paired fields while the dialog keeps its actions reachable. Escape dismisses field guidance before the model dialog; cancelling returns focus to the persistent entry.

Saved-provider dialogs show 42px connection controls with leading icons above a model table. Editing a table row opens the shared model dialog; closing it retains a draft, and only the provider's Apply action commits it. Cancelling the provider dialog discards those drafts. Invalid model values continue to block Apply. Custom route names and protocols sit under Advanced options below the table. Reset/removal stays beside the pinned footer actions, and narrow windows keep horizontal scrolling within the table.

Inline editors retain a collapsed Custom settings fold for adapter fields and use 32px model controls. Provider IDs remain fixed and profile headers remain deployment configuration. The capability editor always shows Off, Low, Medium, High, and Max; it lets users toggle levels accepted by the adapter, while unsupported standard levels remain disabled. The Add level menu exposes further identifiers the adapter schema accepts. A newly added custom pi-ai model starts with Low, Medium, High, and Max mapped to their matching wire values and High as its default; existing models remain unchanged. A model without an override displays installed catalog capabilities; toggling a level creates an explicit subset and preserves inherited wire spellings where available. Advanced controls edit mappings without inferring a protocol from the model name. The default-effort menu omits provider-follow and Off choices; its initial value is High when supported. Removing the selected model default prevents saving until another default is selected. Opening the editor does not rewrite configuration.

The DeepSeek card edits the `llm-deepseek` endpoint, credentials, and model catalog. It uses Messages, with the default endpoint placeholder `https://api.deepseek.com/anthropic`.

Expand **Customized settings → Model options** to edit each model. Both provider families share an editable table layout with Model ID, display name, and action columns; context window and max output tokens occupy two columns, and **Input types** occupies a separate row with **Text** and **Image** checkboxes. A row without an input declaration displays the installed model’s input types, then the provider default, then Text. Known pi-ai providers load their installed catalog without endpoint I/O; opening a row does not write an override. Explicit input selections take precedence, including text-only overrides of vision models. Checkbox edits save the selected types, with at least one type required. DeepSeek writes `inputModalities`; pi-ai writes `input`. Unchecking Image for DeepSeek also removes `imagePixelBudget` and `imageMaxBytes`, because the adapter rejects those limits without image input. Clearing the input field in `cordis.patch.yml` restores adapter inheritance; **Restore default models** resets the entire catalog override. Declare only input types the upstream model can actually process.

The model table numbers its rows. Drag the handle to change their order, or focus it and press Up or Down; the edited array retains that order when saved. Reordering keeps each row's expanded options and unfinished capacity text with that model. Custom settings and model options use reversible 250ms height and opacity transitions with rotating arrows; folded controls remain mounted but inert, and reduced-motion preferences switch immediately. Both catalogs use the shared database outline icon. The credential dot precedes the fixed rightmost Custom badge; hover or keyboard focus replaces the badge with a trash icon without shifting either the name or dot. Touch devices keep the trash icon visible. Deleting another provider retains the current editor and its draft; read-only mode or a pending write disables the action.

A model row on a hand-declared pi-ai route also edits its **Reasoning levels**, the `reasoningEfforts` the adapter already reads from `cordis.patch.yml`; the **?** beside the label explains the two columns. With the switch off the field is absent, so the model does not reason and the model picker offers no level; a stored `false` is kept until the switch is used. Turning it on always starts from rows for off, low, medium, and high; it does not restore levels removed earlier, and **Cancel** discards the edit instead. Each row pairs a level select — the keys `llm-pi-ai`'s configuration schema accepts in `reasoningEfforts`, read from the namespace schema like the protocol choices and today `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, each usable once — with the **API value** sent for it, which starts as the level name; a field cleared while typing stores the level name and shows it once the field is left. Off only turns reasoning off, so its value field is disabled; a value already written for it in `cordis.patch.yml` is shown and kept. Changing a row's level resets a value still spelled as the old level; a custom value carries over only between two thinking levels, so changing a row to or from Off resets it. A stored key the schema does not list keeps its row and stays selectable there. Rows can be added and deleted and are saved in row order, while the model picker lists the levels in escalation order. The section refuses what the adapter refuses: no level besides Off — including a `reasoningEfforts:` left without a value, which shows the switch on with no rows — or a value that is missing on a level besides Off or empty on any level. A refused value marks its field invalid, and leaving that field fills in the level name. The rows keep no state of their own, so a model row reused after a deletion, a reset, or a fold shows only its own model. Routes served from the installed catalog and the DeepSeek card keep the adapter's levels and show no reasoning control.

### Adding and deleting providers

DeepSeek's trash action confirms **Clear configuration** and retains its provider entry. It unsets only the writable user-layer fields at the captured settings revision, then clears an unshared, writable page-managed credential after rechecking its state. Base configuration, environment credentials, read-only credentials, and shared references remain. Provider cards omit empty reset targets. A conflict or failed stage keeps the diagnostic in the confirmation dialog; retry resumes unfinished stages without replaying a completed settings write. Cancelling the dialog preserves the editor draft.

**Add model provider** appears beside the page title, offered while any editor-backed settings namespace is mounted and enabled while either mode below can proceed. The action opens a setup page within Models settings, with Cancel/Add actions beside the page title. The heading and underline method tabs reuse the directory page typography and controls; entering and cancelling use the Settings page exit/enter animation. Method tabs sit below the title; the existing character artwork introduces the active form below the tabs. The built-in provider selector and API key share a row on wide screens and stack on narrow screens. The provider menu searches names and IDs, places common providers first, then sorts other names alphabetically, and gives every brand mark the same space. The setup page hides the configuration-file action. Connection settings and model catalog follow one vertical flow using the available page width. The catalog is a table of model identity, capabilities, context window, and actions; narrow windows scroll only the table horizontally. Advanced options sit below the catalog. Cancelling restores the directory filters, selected tab, and focus on the add action. Model rows open a separate draft dialog for identity, capacity, input, and reasoning settings; Done and Escape retain edits for the provider submission, and newly added rows open for editing. Field guidance uses one SVG explanation icon and a click-open bubble. The Add model action sits beside Fetch available models above the table. Optional guidance stays behind an information button: **Third-party model provider** carries the dormant-directory provider menu over the provider editor — a bare-mounted `llm-pi-ai` offers its whole installed catalog before any route exists — and **Custom model API** carries the create form for a route pi-ai does not ship: a relay, a self-hosted server, or any other OpenAI- or Anthropic-compatible endpoint. A mode is offered only while its namespace is mounted; with one mode the card shows that form alone under the mode's name, and a mode whose namespace has nothing left to adopt or no protocol to declare is disabled with the reason as its hover text. A panel mounts the first time its mode is shown and stays mounted, hidden, while the card is open and its mode stays offered, so switching modes discards neither draft; the switch locks while either panel has a write or an endpoint interrogation in flight, since a switch underneath one would orphan its answer. Each tab controls its panel through ids, and closing either panel forgets the catalog draft's target. The custom form orders display name, protocol and endpoint, credentials, and the model catalog. **Advanced options** contains an automatically generated, editable **Provider ID** with a `custom-` prefix, avoiding ids in the current directory. It retains that value through draft edits and mode switches; a new form generates a new value. The endpoint, protocol, and at least one uniquely identified model remain required. The shared menu protocol picker names each protocol by its product name — OpenAI Chat Completions, OpenAI Responses, Anthropic Messages — while the stored value stays the schema identifier; a protocol the adapter adds before this page names it shows that identifier. The endpoint placeholder follows the selected protocol: OpenAI Chat Completions and Responses show `https://gateway.example/v1`, while Anthropic Messages shows `https://gateway.example` because its SDK appends `/v1/messages`. Changing the protocol preserves any address already entered. The endpoint must be a parseable HTTP or HTTPS URL; localhost, IPv4 and IPv6 literals, and custom ports remain valid. A syntax error blocks both discovery and creation at the field, while a request failure remains a separate provider error. **Fetch available models** asks the `llm/discoverModels` Remote about the endpoint the form shows, so adding a provider is one pass instead of save-then-return; the reply opens a searchable picker rather than being written, and nothing is written until **Add selected**. Each candidate displays its original model id in a monospace font to distinguish models with the same name. Rows stay on one line; hovering reveals the model name, falling back to the full id when no name is supplied. Selection and configuration retain the original model id. Each selected candidate copies its id, display name, context window, output-token cap, and disclosed input types into the editable row when disclosed, while an existing row retains its user-tuned values. Search matches model ids and optional display names without clearing hidden selections. **Select all** adds the visible results, while **Deselect all** clears the entire selection so hidden results cannot be adopted accidentally. A row is deletable only when the user layer alone carries it (removal restores the composition base), and its confirmation dialog names the provider.

### First-run dialogs

After the versioned notice step completes, the DeepSeek step projects first-run readiness from the same joined snapshot. ANY provider the user can already reach ends it without rendering; only a user with none is asked for the official DeepSeek key. Configure later completes only this coordinator pass, and an absent adapter, inactive route, failed join, read-only deployment, or unusable capability completes the step without rendering — Models remains the diagnostic surface.

### Extension slots

The section declares two seats for plugins distributed outside this repository, typed in [`src/client/slot-contract.ts`](src/client/slot-contract.ts) and exported from `./client`. `settings.models.provider-card` (keyed) renders for the selected saved provider, or the add-provider draft — dispatched with `entryKey = settingsNs` and owner props carrying the row's `ConfigurableProviderView`, its configured state, and its confirmed api-key credential state, so one registration under an adapter family's namespace receives that family's selected detail, hand-declared routes included; the hand-declared draft card has no directory row yet and dispatches nothing until saved. `settings.models.footer` (list) renders after the provider workspace. A registrant activates through `ctx.slots.inject` with a type-only import of this package's `/client` entry; without registrants both seats render nothing.

The Models page includes **DeepSeek Account** (`deepseek-account`, **DeepSeek 账号** in Chinese). The row shows a **Signed in** status and offers no editor: the account listing supplies its models, and [model overrides](../../llm/llm-deepseek-account/README.md#use-this-package) live in `cordis.patch.yml`. The account row is hidden when its available model catalog is empty, including before sign-in and after sign-out; it returns when account models become available.

-----

The page uses the shared settings heading and insets. Narrow windows wrap the filters and keep horizontal table scrolling inside the directory. The setup heading uses the catalog character artwork on the left, with compact connection-method tabs and a 42px provider picker. Catalog model editing and provider drafts share `ModelEditorDialog` and the same field groups; draft actions retain their provider-level save semantics. A generated transparent character illustration marks an empty custom catalog.

Provider brand marks are bundled from [Magpie](https://github.com/yetone/magpie/tree/e056779a67d2024a09aa25edad8a4373931a5b64/internal/gui/assets/icons). Explicit route aliases select the mark; unknown routes keep the existing globe. Monochrome SVGs inherit the theme color through a mask. [Source and license notices](src/client/assets/providers/NOTICE.txt) are also included in the SVG image data, so displaying marks requires no external requests.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The page never holds a full settings section: it holds only the REDACTED descriptor, so every edit lands as `settings.mutate` path ops against the stored section — a set per changed field, an unset per cleared one, and a single unset for a deleted provider row.

The built-in `settings.models.subscription` slot owns the third directory tab. Its controller loads on first visit and owns login polling until completion, cancellation, or plugin disposal. Account cards expand independently, defaulting to the first account; compact cards retain identity, authorization, the enable switch, and both quota windows. Account keys preserve expansion choices across refreshes and reordering. Shared `AnimatedCollapse` keeps transitions reversible and closed controls inert, while honoring reduced-motion settings. Workspace and expiry fields form a compact grid, with credit balances and the explicit extra-credit switch in a separate panel. Subscription content scrolls independently and hides the configuration-file footer. Operation feedback uses the shell overlay so it survives tab changes; failed writes retain account rows and open drafts. Codex discovery preserves each returned model's capacity, input modalities, and reasoning capabilities when refreshing the shared directory.

### Validation

A typed API key is judged on its own field: after trimming, it must be non-empty and every character must be printable ASCII (`[\x21-\x7E]`), which is exactly what an HTTP header value can carry — the twin of `normalizeApiKey` in `@deepseek-ai/dsh-llm`, mirrored here because the source-plane split forbids importing it. A value matching a pasted `NAME=value` environment line or wrapped in matching quotes is refused as the same format failure. Empty ids, duplicate ids, empty explicit names, and unreadable, non-positive, or fractional capacities fail before any write. DeepSeek's `models` is one replace-by-value array: the editor shows inherited effective rows until the first model edit materializes the complete array in the user layer, while reset unsets that override.

### Concurrency and credentials

Each settings write carries the card's current `revision`, so a concurrent write from another tab or an external `cordis.patch.yml` edit is refused as `settings/conflict`. After settings commit, the card adopts the returned redacted user subtree and revision before storing the credential, so a failed credential stage retries only that stage. Deletion removes a configured, writable credential only when the profile names the page's derived `<ROUTE>_API_KEY` target, then unsets the profile; both operations are idempotent. Once loaded, the page subscribes to forwarded `settings/document-updated`, `credentials/reference-updated`, and `llm/adapters-updated` owner events, plus local `connection/reset`, so external edits converge without polling.

Concurrent `ModelsSettingsStore.load()` callers resolve after the current refresh publishes its ready or error snapshot, including callers whose reads were superseded. Older responses cannot publish or settle callers; a refresh started synchronously by a snapshot subscriber owns the waiting callers. Both Remote failures and unexpected read rejections publish error diagnostics and settle waiting callers without an unhandled rejection.

### Onboarding coordinator

The notice step owns its exact copy in `src/client/locales.ts` and its acknowledgement version in `src/onboarding-copy.ts`. Authenticated browsers compare and write `ui-settings-general.welcomeNoticeVersion` through the shared configuration form; only an explicit Continue records the current version, and an unavailable namespace or a refused write leaves the notice unacknowledged. Users who acknowledged an earlier version see the current notice again. The DeepSeek step targets `deepseek-official` in `llm-deepseek` and renders the existing `ProviderEditor` in credential-only mode inside the shared onboarding modal; `credentials.set` stays the only secret write, and no provider settings are changed.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings base, the seams this page joins, and the design rationale.

- [ui-settings](../ui-settings/README.md) — the domain base whose scope and schema services this page builds on.
- [settings](../../settings/README.md) — the durable user-settings seam and its file provider.
- [credentials](../../credentials/README.md) — the credential-reference seam this page writes keys through.
- [llm](../../llm/README.md) — the adapter registry whose providers this page configures.
- [Web config plane](../../../.agents/notes/archived/architecture/2026-07-30-web-config-plane.md) — the hand-written editor's design rationale.

-----

The `settings.models.sign-in` slot lets account login offer a choice before the credential editor; without a contributor the editor renders directly. Closing the account choice completes the whole onboarding step. Explicit reopening from the account menu enters the same editor even when a provider is already configured.

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the editor's field coverage and the page's reach; they are current package constraints, not a settings roadmap.

- **Only the API key and curated fold fields are editable on the card** — the hand-written editor traded schema-generic field coverage for the mockup layout. Retry policy, timeouts, DeepSeek model descriptions, and other advanced fields remain in `cordis.patch.yml`; existing model fields the editor does not show are preserved.
- **Credential cleanup is intentionally narrow** — deleting a row removes the configured, writable credential only when its reference is the exact `<ROUTE>_API_KEY` target this page derives. Custom references, environment credentials, and unidentifiable targets are retained because the row cannot prove ownership of them.
- **Only pi-ai routes can be hand-declared** — the custom-API form writes into `llm-pi-ai`, the one namespace whose profiles describe a whole provider. A `llm-deepseek` route is a composition fact, not something this page can create.
- **The catalog select lists route identifiers** — `moonshotai`, `zai`, and the other pi-ai catalog ids appear as they are, with no product names, aliases, or search. A searchable picker with the custom form as one pinned entry would let the mode switch go; it needs the directory to carry display names first.
- **Interrogation covers OpenAI-compatible and Anthropic Messages endpoints** — OpenAI protocols accept a standard `data` array or an enriched `models` map, while Anthropic uses its native model-listing route; every other protocol reports that it cannot be asked and its models are entered by hand.
- **Undeclared live routes render nowhere** — a route registered without a configurable-provider declaration has no settings address; it stays visible in pickers but not on this page's rows.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
