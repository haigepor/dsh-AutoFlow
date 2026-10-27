# MCP settings verification

Verified on 2026-10-28 in the existing Windows workspace. Unrelated worktree changes remain present.

## Delivered behavior

- Settings → MCP provides live server rows, stdio and Streamable HTTP creation, redacted detail editing, persistent enablement, server restart, and explicit application restart.
- Configuration and connection readiness are separate. Existing conversations retain their identity and history and receive the updated tool set on subsequent model steps.
- Saved environment and header values remain hidden. Unchanged credentials and expressions survive edits; stale revisions and invalid or duplicate declarations are rejected.
- The configuration-file footer is hidden in MCP settings. The regenerated transparent mascot sits left of the introduction; shared Tooltip guidance supports hover, focus, and click. Light, dark, and 480px layouts retain the existing settings style.

## Validation

| Command or check | Result |
|---|---|
| `pnpm run build:artifacts` | PASS, 11 gates |
| `pnpm run build:check` after the latest artifacts | PASS, Host and Client aggregates |
| Focused MCP client connection/apply/reconnect tests | PASS, 58 tests |
| Focused management configuration, connection inventory, UI, restart recovery, and settings shell tests | PASS; 19 tests before the final layout adjustment, then the affected UI/shell/restart files passed again with 16 tests |
| `vitest run --config vitest.e2e.config.ts packages/mcp/mcp-manager/tests/management.e2e.ts` | PASS, 2 tests; real HTTP MCP exchange and an existing Agent calling the new tool |
| `vitest run --config vitest.web.config.ts apps/web/tests/mcp-settings.e2e.ts` | PASS, real Chromium; add, edit, credential masking, restart, disable, help, restart confirmation, themes, and responsive checks |
| Scoped Oxlint over changed source/tests and Remote assembly | PASS |
| `pnpm run test:docs` | PASS, 21 gates, including type equivalence and bilingual pairing |
| `pnpm run verify-package-dependencies` | PASS, 86 package classifications |
| `verify-export-jsdoc` and `verify-client-ui-i18n` | No MCP/shared-primitive JSDoc violations; the latest global scan has six unrelated subscription-controller violations. Client i18n passes. |
| Cordis API and Client slot catalog freshness | PASS |
| Scoped UTF-8/BOM/replacement-character and `git diff --check` inspection | PASS; DOM golden files retain the native serializer format |

Owner-local DOM and Web accessibility snapshots accompany the change. The browser run uses the repository scaffold, the in-page directory-picker overlay, isolated profiles, and no external model credentials. The MCP server restart performs a new HTTP handshake without duplicate tool registrations. The existing-Agent test verifies successful tool execution after enablement and removal from later requests after disablement.

## Changed files and impact

| Files | Purpose and impact |
|---|---|
| `packages/client/ui-settings-mcp/` | New Client page, forms, shared operation feedback, recovery helper, locales, artwork and prompt, package/build metadata, snapshots and tests |
| `packages/mcp/mcp-manager/` | New Host management service, redacted DTOs, validated configuration editing, and integration tests |
| `packages/mcp/mcp-client/src/{connection,index,connections,types}.ts`, package metadata and `tsdown.config.ts` | Optional live inventory and connection phase reporting; ordinary client ownership remains intact |
| `packages/boot/config-editor/src/index.ts` | Locked, atomic entry insertion and validated inactive editing with rollback |
| `packages/boot/plugin-manager/src/index.ts` | Configuration restart admission independent of pending upgrades |
| `packages/client/ui-settings-general/src/client/{SettingsPage,SettingsNavIcon}.tsx` and shell tests | MCP navigation, grouping, and footer visibility |
| `packages/api/remotes/`, `packages/bundle/web-app/`, `apps/cli/package.json`, root package/lock/tsconfig files, `apps/web/tsconfig.json` | Runtime composition, generated Remote projection, dependencies, and compiler ownership |
| `apps/web/tests/mcp-settings*`, its expected output, MCP/boot package READMEs, and `docs/subsystems/{mcp,boot}*` | Product verification and API documentation |
| `scripts/{gen-cordis-catalog.ts,type-equiv.manifest.json}` and generated Cordis/Client catalog files | Documented service/event/type ownership and fresh inspection data; existing source-location drift is refreshed mechanically |
| This OpenSpec change | Accepted behavior, design, completion, and validation evidence |

The exact file inventory and pre-task copies are retained in `C:\Users\zhuyi\AppData\Local\Temp\dsh-mcp-settings-baseline-20261027`. Generated catalog baselines are under `catalog-baseline`; the earlier Client slot catalog is `slot-catalog-before.ts`. Original clean documentation is included in the same baseline copy. Rollback removes the new packages/composition entries and restores only this task's edits, preserving unrelated work. Stored server declarations use the existing MCP client configuration format.

## Remaining limits

- The repository-wide Client domain graph reports 129 existing violations outside this MCP change. The final run contains no MCP violation. This check is not claimed as passing.
- The latest exported-JSDoc scan reports six violations in `packages/client/ui-settings-models/src/client/subscription-controller.ts`, outside the shared help adapter modified here. They remain separate from this change.
- Web readiness recovery, refusal, and cancellation are tested; the browser test confirms and cancels the application-restart dialog. Native Desktop quit/relaunch was not exercised against a live user application. It reuses the existing preload lifecycle route.
- Server executables and provider authentication must already be available. Already issued model requests keep their original schemas; an explicit full application restart interrupts running tasks while retaining stored history.

## Visual evidence

Final screenshots are saved under `C:\Users\zhuyi\.codex\visualizations\2026\10\27\01a17dbb-8399-7e72-8aba-cfc357a34152`: `mcp-list-light.png`, `mcp-list-dark.png`, `mcp-list-narrow.png`, and the corresponding detail screenshots. The final image asset is `packages/client/ui-settings-mcp/src/assets/mcp-connection-whale-maid-v2.webp` (600 × 450, alpha retained); its neighboring prompt records the built-in image generation request and corrected feet.

## Shared controls and JSON editor

Models and MCP now use the same `ui-primitives/FieldHelp` implementation and CSS. The existing Models component remains a locale adapter. The shared control retains the speech-bubble SVG, MenuSurface material, viewport placement, outside-pointer dismissal, Escape/Tab handling, and focus return. Transport selection uses Menu rather than the OS-native select. Advanced fields use AnimatedCollapse; loading rows and detail fields use actual theme skeleton/radius tokens, with reduced-motion handling.

The JSON toolbar action opens a localized Modal with a controlled native CodeEditor. Its highlight spans come from the existing lazy Shiki highlighter and `--shiki-*` theme variables, while native text selection, undo, and composition stay with the textarea. The JSON reader redacts saved environment/header values. Imports preserve omitted services, hidden values, original edit revisions, and unchanged expressions. Each server is an independent existing Host operation. A later conflict stops the batch, retains the draft, and reports partial progress. Explicit reload waits for a fresh resource snapshot.

The additional focused suites pass 21 tests; the two Models consumer suites pass 255 tests. The real Web flow verifies JSON editing, adding a disabled service, retained authorization, an externally changed revision, partial-import feedback, and reloading the authoritative state. Native Playwright MCP inspection also observes Shiki-colored JSON spans and a 300px help panel. Browser inspection identified an HTML-pattern Unicode-set incompatibility; the name pattern now escapes its hyphen and has a regression assertion.

| Additional changed files | Purpose |
|---|---|
| `packages/client/ui-primitives/src/FieldHelp.tsx`, `FieldHelp.module.css`, `CodeEditor.tsx`, `CodeEditor.module.css`, `index.ts`, tests and README pair | Shared controls, syntax colors, accessibility and lifecycle ownership |
| `packages/client/ui-settings-models/src/client/FieldHelp.tsx`, `ModelsSection.module.css` | Preserve Models behavior through the shared help control and remove its duplicate CSS |
| `packages/client/ui-settings-mcp/src/client/{McpSettings,McpEditor,McpSkeleton,McpJsonDialog}.tsx`, `configuration-json.ts`, `McpSettings.module.css`, registration, contract, locale, DTO re-export, tests and README pair | Themed controls, structural loading, JSON merge workflow and feedback |
| `apps/web/tests/mcp-settings.e2e.ts`, its accessibility golden, and generated Client slot catalog | Assembled browser evidence and current public primitive metadata |

Before-polish file copies are retained at `C:\Users\zhuyi\AppData\Local\Temp\dsh-mcp-polish-baseline-20261028`. Rollback compares those copies with the scoped diff, restores only this segment's edits, removes its new files, and regenerates the Client slot catalog. This preserves the earlier MCP feature and unrelated concurrent work. Additional screenshots include `mcp-help-light.png`, `mcp-json-light.png`, and `mcp-transport-light.png`.
