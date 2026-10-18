# Agent Note: Network capture as a first-class reverse-engineering surface

Status: implemented

English | [中文](2026-10-17-network-capture-reverse-surface.zh.md)

## Problem

The toolkit retrieves article text and saves image plans. When an article cannot be retrieved, the failure is a single code (`article-extraction`, `article-restricted`, `article-render`) and nothing about the page's own network behaviour survives the attempt. An operator trying to work out why a page serves no text in HTML — or which JSON endpoint actually carries the article — has to reproduce the load by hand in browser devtools, outside the tool.

The renderer already routes every request through an owned, address-pinned transport, so the exchanges it sees are the exact ones a reverse-engineering view needs. Before this change they were discarded after routing.

## Decision

Record, inventory, replay and export network exchanges as a separate tool family, without touching the existing eleven tool contracts or the `state.json` schema.

| Module | Responsibility |
| --- | --- |
| `src/har.js` | HAR 1.2 build/parse, credential redaction for headers and bodies |
| `src/endpoints.js` | URL templating, endpoint inventory, tracker classification |
| `src/recorder.js` | Private capture storage, atomic publication, HAR export/import |
| `src/replay.js` | Override-based replay over the pinned transport |

Six tools are added: `capture_record`, `capture_endpoints`, `capture_exchange`, `capture_replay`, `har_export`, `har_import`. The renderer gains two options — `onExchange` and `markup` — so a recording run does not depend on extraction succeeding.

### Credential boundary

Tool output is redacted by default; `reveal: true` is an explicit per-call switch. Raw values live only in `<dataDir>/captures/<id>/raw/NNNNN.json` (0600 inside a 0700 tree). Redaction covers request and response headers, JSON bodies by key suffix, and form-encoded bodies field by field, so a recorded login POST never echoes its password. Endpoint summaries carry cookie names, counts, auth scheme and length only.

### Replay target validation

A capture can hold a loopback or private address if it was recorded under a test policy. Replay therefore re-runs `captureUrl` and the public network policy on every target, and restricts caller-supplied headers to non-credential metadata. Credentials can only come from the recording, and `credentials: 'omit'` drops them.

### Write requests

The renderer answers only GET and HEAD. A page's login POST is recorded with `sent: false` and `blocked: article-resource-method` rather than silently discarded, because those requests are the most informative endpoints for a reverse-engineering task.

## Alternatives considered

**Embed a HAR implementation from `har-skills`.** It is a Go CLI (MIT), so using it would add a binary and a language runtime to the Node toolkit. HAR 1.2 is an open specification; implementing build/parse natively is a few hundred lines and keeps the export interoperable with that tool.

**Expose the rich block model through the existing `article_image_article`.** That tool's paragraph contract and `state.json` schema:1 are consumed by saved plans and approvals. Changing it would force a migration for a capability that is additive; a separate tool keeps both contracts stable.

**Store captures in `state.json`.** Capture payloads can exceed the state byte budget; `state.json` is rewritten on every plan save. Separate private directories with atomic rename match the existing `capture-sources` layout; replay appends records and updates only the capture index.

**Adaptive element relocation in this phase.** It is the other genuinely missing capability, but it needs the capture surface to exist first for verification. It belongs to a later phase and does not gate this one.

## Retrieval stability

The capture surface makes a page's network behaviour inspectable; it does not make retrieval succeed more often. Three facts decide whether a page is readable at all, and each previously had no owner:

| Module | Responsibility |
| --- | --- |
| `src/decode.js` | Charset negotiation: BOM, header, `<meta>`, valid UTF-8, then byte evidence |
| `src/session.js` | Per-origin cookie jar shared by static retrieval, the renderer and the recording browser |
| `src/pacing.js` | Per-host token bucket, `Retry-After` (delta-seconds or HTTP-date), host-level blocking |
| `src/pipeline.js` | The static → structured → browser ladder, ordered by failure family |

### Failure families instead of an error-code whitelist

The previous escalation rule was a hardcoded set of error codes (`RENDERABLE`) that could be rendered. That set answers "which failure am I willing to pay a browser launch for", but not "would a browser change the outcome", which is the only question that matters. Failures are now classified into families:

- `content` — the document arrived but its text needs script execution. `structured` (JSON-LD `articleBody` from the same bytes) then `browser`.
- `client` — the server refused this client, typically a 403 against a non-browser user agent. Straight to `browser`; `structured` re-reads bytes the server already refused.
- `decision` — the server answered about access or existence (404, 429, 5xx, login wall, paywall). A browser reproduces the same answer, so the ladder ends here and the error code is preserved.
- `transport` — no document arrived. Rendering repeats the same network path; raise the timeout instead.

Escalation scans forward for the first rung whose families contain the failure family, so an intermediate rung is never a chokepoint. Unknown codes default to `transport`: a failure nobody classified must not trigger an expensive browser launch on the assumption that rendering would help.

The `size` family also escalates to the browser: the renderer requests the document separately and prunes it before serialization, while its own download and output limits remain enforced. The authoritative mapping is `src/pipeline.js`.

### Charset

Declared encodings win and are never re-scored; the byte-evidence pass runs only when nothing declared one and UTF-8 fails. It scores CJK density minus decoding damage across a fixed, ordered candidate set (`gb18030`, `big5`, `shift_jis`, `euc-kr`, `windows-1252`), so an undeclared GBK article decodes as text instead of replacement characters. `gbk`/`gb2312` normalize to `gb18030` because it is a superset; `latin1`/`iso-8859-1` normalize to `windows-1252` because the latter is what browsers actually decode.

### Sessions and redirects

One jar spans static retrieval, the renderer and the recording browser, so a cookie a page sets in static retrieval is present when the same URL is rendered. Cookies follow RFC 6265 host, domain and path rules; `__Host-`/`__Secure-` prefix violations are dropped rather than sent, and a `Domain` naming a public suffix is rejected so one site's session cannot leak to every site sharing `com.br` or `co.uk`.

The pinned transport follows same-origin redirects internally and previously returned only the final response headers, discarding `Set-Cookie` set on a hop. A gate that 302s to the article while issuing its session cookie therefore lost that cookie and the article read as a 403. Hop cookies now accumulate and are returned with the final response, and a 401/403 that also set a cookie is retried once with it.

### Pacing

Each host owns a token bucket (`hostRatePerSecond`, `hostBurst`); a 429 or a 503 carrying `Retry-After` blocks that host for the server-directed delay, capped by `maxRetryAfterMs`, and the request is retried once. A second refusal returns as-is instead of amplifying the wait into a retry storm, and other hosts keep flowing. Buckets are per host because one slow publisher must not stall retrievals from another.

## Verification

Deterministic coverage lives in `article-image-toolkit/test/record-replay.test.js`, `session.test.js`, `decode.test.js`, `pacing.test.js`, and `pipeline.test.js`. The following live-source targets retain the original acceptance criteria; a passing offline suite does not establish the Folha exchange-count target or current public-site availability.

- Recording the sample folha article with `scope=api` yields at least 15 exchanges and at least 8 endpoints, of which at least 5 are site-owned rather than trackers.
- No default tool read contains a bearer token or a raw cookie value; `reveal: true` returns them.
- A replay with changed query parameters returns 200 and appends an entry to the same capture.
- Export, then import, preserves entry and endpoint counts.
- A captured loopback target is refused with `article-url-blocked` under the production policy.
- The entry budget truncates and reports `dropped` instead of failing.
- The eleven pre-existing tools keep their schemas and behaviour.

Retrieval stability:

- A GBK page that declares its charset only in `<meta>` decodes without replacement characters, and so does one that declares nothing at all.
- A 429 with `Retry-After` is retried once and succeeds; a 503 without the header is not retried; a second refusal is returned as-is.
- A `Set-Cookie` issued on a redirect hop survives into the jar, and the same cookie reaches the browser when the page is rendered.
- A 403 that also sets a session cookie is retried once with that cookie.
- A paywall, login wall, 404 or 429 never launches the browser; a 403 does.

## Consequences

- The tracker host list is a static heuristic. A site that serves its own API from a lookalike CDN host will be classified as a tracker; `owner: 'all'` still returns it.
- `recordScope: 'api'` keeps documents, XHR, fetch and WebSocket. Sites that deliver article data over a resource type outside that set — an EventSource stream, for example — need `all`.
- Captured raw files hold plaintext credentials by design. The directory permissions and the redacted default are the control; a user who copies `raw/` elsewhere removes that control.
- HAR export writes original header values to disk. The tool description says so, but an exported file is a credential-bearing artifact.
