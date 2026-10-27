---
description: "Codex subscription authentication, image tools and local HTTP services for AutoFlow."
kind: "package-bundle"
---
# dsh-plugin-codex-subscription

English | [中文](README.zh.md)

## Summary

Use ChatGPT subscription accounts for AutoFlow model calls, image generation and local OpenAI-compatible clients. The bundle supplies Host services, native image tools and an HTTP MCP server. It has no browser entry, settings page or other standalone UI. An existing authenticated caller starts OAuth; account/login presentation belongs to the model settings consumer.

## Table of Contents

- [Use this package](#use)
- [Management operations](#management)
- [Configuration](#configuration)
- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations](#limitations)

<a id="use"></a>
## Use this package

AutoFlow ships this bundle as an optional installation dependency. Shipped profile templates leave it disabled. Enable it through the existing plugin manager, or add its package name to the profile's selected bundles. The inserted rows are `codex-subscription` and the independently switchable `codex-subscription-tools`. Disabling the bundle stops listeners and work while retaining credentials and images.

The Installed plugins section offers independent GitHub updates through the same updater as AFP. Checks use the bundle's declared stable source; automatic installation requires explicit opt-in, and updates take effect after restart while retaining account data and configuration. See the [release guide](release/README.md) for the source, assets and verification limits. The Models page remains part of the AutoFlow application.

The registered model provider is `autoflow-codex`. It advertises account-discovered models, including new IDs whose server entries declare context and input capabilities. Installed native capabilities fill omitted fields for known IDs. No provider page or sign-in button is contributed by this bundle.

The local relay defaults to disabled at `127.0.0.1:3426`. It requires a separately revocable gateway key, even on loopback. The key is returned once by `gateway-create`; account OAuth tokens never cross management responses.

| Route | Behavior |
|---|---|
| `GET /v1/models` | Available subscription models |
| `POST /v1/responses` | Raw Responses SSE or aggregated terminal JSON |
| `POST /v1/chat/completions` | Text/image inputs, function tools, streaming |
| `POST /v1/images/generations` | Generate images |
| `POST /v1/images/edits` | JSON/multipart references and optional mask |
| `POST /mcp/image` | Streamable HTTP `generate_image` / `generation_result` |

External clients use `Authorization: Bearer <gateway-key>`. Image results may contain inline originals or short-lived, task-bound signed download URLs. The server does not accept arbitrary server-local file paths.

MCP also accepts `/mcp/magpie/image`, Magpie's `reference_images` and `generation_result({id})`, and the existing `referenceImages`/`task_id` spellings. Pending/file metadata uses `usemagpie.ai/pending` and `usemagpie.ai/files` for compatible consumers. Images that exceed the inline budget retain signed download URLs. Image input supports size ratios and `outputFormat` (`output_format` on HTTP/MCP).

<a id="management"></a>
## Management operations

An authenticated owner can call `POST /api/codex-subscription/manage` with `{ "operation": "…", "args": { … } }`. Host consumers can invoke the `manage` action of `dsh-plugin-codex-subscription` through the existing plugin manager. These are control interfaces, separate from gateway-key-authenticated inference and MCP.

| Operations | Result |
|---|---|
| `login-start`, `login-status`, `login-complete`, `login-cancel` | Browser authorization URL, safe status, callback submission/cancellation |
| `account-list`, `account-update`, `account-remove`, `model-list` | Safe account metadata, revision-checked edits, discovered models |
| `account-status`, `account-quota`, `account-refresh` | Full account state, last-good quota, or explicit usage/model refresh |
| `model-routes` | Complete capability groups, stable IDs, upstream model IDs and eligible account keys |
| `configure`, `snapshot` | Revision-checked configuration and bounded status |
| `protocol-status` | Safe WebSocket counters, fallback memory and negotiated version sources |
| `gateway-create`, `gateway-revoke`, `relay-test` | Gateway key rotation/revocation and local connection test |
| `image-submit`, `image-result`, `image-cancel`, `history-prune` | Durable task handles, results and explicit history cleanup |

For login, call `login-start`, open its `authorizationUrl` in the user's browser, and poll `login-status`. Automatic callback and manual `login-complete` share PKCE/state validation. Ports 1455 and 1457 are supported callback choices. The plugin neither submits passwords nor cancels another application's login listener.

Account identity combines the user and workspace. Different Team members remain separate; signing in again preserves a matching account's key, controls and label, including legacy keys referenced by tasks or replay. Metadata includes user/email, workspace, token expiry (`tokenExpiresAt`, with the compatible `expiresAt` alias), optional future subscription expiry (`subscriptionUntil`), plan source, auth state, operation cooldowns and discovery timestamps. Live usage plans override token claims; omitted quota stays unknown.

Host plugins inject `codexSubscription` and use `accounts.getAccountStatus(accountKey)`, `accounts.getAccountQuota(accountKey)`, `accounts.refreshAccount(accountKey, signal)` and `accounts.modelRoutes()` alongside login, account edits, model discovery and image methods. Status/quota reads are local by default; `{ fresh: true, signal }` explicitly refreshes usage and models, bypassing TTL and sharing concurrent refreshes. Owner actions take `{ accountKey, fresh? }`; `account-refresh` takes only `{ accountKey }`. `requestResponses(body, signal)` returns a body that must be consumed or cancelled; `protocolStatus()` reads local transport/version state.

`auth.state` is `ready`, `refreshing`, `refresh-required` or `needs-login`. Terminal refresh refusals persist against the credential generation until successful refresh or reauthorization; network/5xx failures remain retryable, and stale refusals cannot revoke newer credentials. Quota reports credits, allowed/held state, spending limits, window durations/resets and available reset credits with optional expiry. `status`, `freshness`, `lastSuccessfulAt`, `attemptedAt` and safe `errorCode` distinguish last-good values from a failed read. Reset details are read-only; the plugin never redeems resets automatically.

`account-update` accepts revision-checked `allowCredits`, defaulting to `true` as in Magpie. Setting it to `false` holds text requests on known spent, unreset windows through failed/partial polls and restarts. Usage polls and live HTTP/WS observations persist through the Home credential provider; writes drain on shutdown. Upstream held/workspace-overage rules also participate in text scheduling. `Retry-After` seconds and HTTP dates extend operation cooldowns without shortening existing waits; safe retry/request metadata survives native errors, image task storage and local HTTP errors.

The shared request schema is owned by [management.ts](src/shared/management.ts). Raw access, refresh and ID tokens remain in Host credentials. Model-visible native image tools do not expose account or gateway administration.

<a id="configuration"></a>
## Configuration

The profile patch supplies deployment settings. This example keeps the relay off until a gateway key has been created:

```json
[{"id":"codex-subscription","config":{"options":{"images":{"defaultModel":"gpt-image-2","timeoutMs":300000},"relay":{"enabled":false,"port":3426}}}}]
```

Defaults and accepted limits are defined in [config.ts](src/host/config.ts). Image tasks default to a five-minute deadline, configurable up to one hour; native/MCP quick waits are bounded to twenty seconds. Accepted tasks retain their settings. Gateways enforce body, response, concurrency and signed-URL limits.

`options.upstream.mode` defaults to `auto`; `sse` forces HTTP. WebSocket connection timeout defaults to 30 seconds, unsupported-host and 1009-size memory to ten minutes, message limit to 16 MiB and queued bytes to 32 MiB. Each socket retains its admission settings. `options.models.fallbackMaxTokens` defaults to 8192 when a new model has no server output limit. `options.version` controls local metadata discovery, its ten-minute probe interval and bounded cache reads.

<a id="implementation"></a>
## Implementation

<details>
<summary>Implementation details</summary>

[plugin.ts](src/host/plugin.ts) registers accounts, the provider, discovery and authenticated management. Internal model calls reuse `PiAiAdapter`; its SSE consumer and external Responses share [upstream.ts](src/host/upstream.ts). Only streaming POSTs to the fixed Codex Responses endpoint use WebSocket. Image REST and OAuth calls remain HTTP. [ImageService](src/host/images/service.ts) supplies native tools, MCP and Images routes from one durable task service.

WebSocket handshakes use `responses_websockets=2026-02-06` and send `response.create`. Turn-state/Lite headers move into `client_metadata`; metadata and quota prelude events become safe response headers. Refused handshakes, connection-limit errors and closes before response publication fall back to the original HTTP body. Unsupported hosts and 1009 message sizes are remembered separately; 401, 429 and server handshake failures do not disable the next WS attempt. Once a response is published, stream failure never triggers HTTP replay. Cancellation and shutdown close sockets, timers and owned proxy agents; proxy routing follows the Host launcher.

[models.ts](src/host/models.ts) consumes server context, maximum context, output budget, modalities, reasoning levels/defaults and service tiers. [routes.ts](src/host/accounts/routes.ts) groups complete capabilities: the upstream model ID selects the strongest complete group, ranking context first; other groups use `dsh-cap:…` IDs. `model-routes` also exposes each group's stable `capabilityId`, still resolvable when it becomes the default. Every fallback account must support all advertised capabilities. Preparation freezes descriptors, defaults and accounts; new accounts or later catalogs cannot change a prepared call. Native and raw requests send the real upstream model ID. Explicit raw reasoning/tier requests select a compatible complete group; incomplete unknown models stay unavailable.

[version.ts](src/host/version.ts) selects the newer numeric version among `clientVersion`, installed Codex package metadata, `models_cache.json.client_version` and authenticated gateway clients' version/User-Agent hints. It never lowers the selected version, executes a discovered CLI or reads `auth.json`. Discovery refreshes after version changes, and the shared fetch applies the selected version to model-list queries, version headers and Codex User-Agent values. Local discovery can be disabled without disabling authenticated client hints.

[codex-request.ts](src/host/codex-request.ts) shares stateless history conversion, cache identity, reasoning and service-tier rules. Caller instructions and explicit tool choice remain intact. The configured version baseline defaults to `0.159.0`. Complete 401/402/403/429 refusals before output can advance once through eligible accounts; terminal pre-dispatch refresh refusals can also advance. Ordinary server failures, network uncertainty and partial output never replay. A 401 can renew the rejected credential under the shared lock without repeating the rejected operation.

Tasks are isolated by profile and hold a cross-process writer lease through recovery and shutdown. Received originals and normalized previews are saved separately. A restart or interruption after dispatch records `outcome-unknown`; it never automatically repeats a paid request. Account credentials are independently persisted in the Home credential provider.

</details>

<a id="model-experience"></a>
## Model Experience

The `autoflow-codex` provider preserves AutoFlow's logged system instructions. `codex_image_generate` returns a durable task; `codex_image_result` queries or cancels it. Canonical tool results preserve attachment references and task state. Image content is emitted to the model only when its input capabilities allow it.

<a id="limitations"></a>
## Known Limitations

Codex subscription authorization is separate from OpenAI Platform API keys. Model/image access depends on account/workspace entitlements, and Codex-specific endpoints can change. Catalogs remain instance-local: failed first discovery after restart returns an empty directory. Known quota persists; accounts without successful observations remain unknown. Older plugin writers may discard new optional health/quota fields; avoid running older and newer versions against one Home. Previously overwritten credentials cannot be recovered by the identity fix.

Remote image downloads currently require public IPv4 destinations and standard HTTP(S) ports. Local paths, private destinations, IPv6-only destinations and credential-bearing URLs are rejected. Text streams are never spliced across accounts after output begins. Stateful Responses continuation and unsupported Chat options are explicitly refused.

The bundle has no application executable, stdio server or custom UI. OpenAI's external login page remains part of OAuth. Model-page login presentation is owned by its consumer, outside this package's browser code.

This is the Codex OAuth integration. It does not implement Magpie's separate `chatgpt-api` Sign in with ChatGPT provider, automatic import of other applications' credentials, native Codex auxiliary routes (`alpha/search`, compact/Lite), or the full multi-provider router. A standalone CLI binary without package/cache metadata needs an explicit `clientVersion` baseline or an authenticated client hint. Remote image downloads use the pinned-address loader and may require direct egress even when API fetch uses a proxy.

## Development

```sh
pnpm --filter dsh-plugin-codex-subscription run check
pnpm --filter dsh-plugin-codex-subscription test
pnpm --filter dsh-plugin-codex-subscription run build
```

### Dev Note

Protocol fixtures, lifecycle tests and source builds do not establish an account's live subscription/image entitlement. Full authorization, inference and image validation require a user-completed login and that account's available quota.
