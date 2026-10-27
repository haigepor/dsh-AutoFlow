/** Subscription account management; token leases never cross the Host wire. */
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ModelSettings } from '../models.ts'
import type { AccountView, AccountUsage } from '../../shared/accounts.ts'
export type { AccountView, AccountUsage } from '../../shared/accounts.ts'

/** Independent capacity and failure domain used by the account scheduler. */
export type AccountOperation = 'text' | 'image' | 'models' | 'usage'

/** Browser login progress; authorizationUrl contains PKCE challenge, never verifier. */
export interface LoginView {
  loginId: string
  state: 'waiting' | 'exchanging' | 'authorized' | 'cancelled' | 'failed'
  authorizationUrl: string
  redirectUri: string
  expiresAt: number
  error?: string
}

/** Account-scoped capabilities from the server, with explicit installed/local fallbacks. */
export interface CodexModelView {
  id: string
  name: string
  input: readonly ('text' | 'image')[]
  contextWindow: number
  maxTokens: number
  maxContextWindow?: number
  reasoningEfforts?: readonly ModelThinkingLevel[]
  defaultReasoningEffort?: ModelThinkingLevel
  serviceTiers?: readonly string[]
}

/** One complete model capability group and the safe account keys that can satisfy it. */
export interface CodexModelRouteView extends CodexModelView {
  baseModelId: string
  capabilityId: string
  routeKind: 'default' | 'capability'
  accountKeys: readonly string[]
}

/** One Host-only request pinned to an enabled account until it settles. */
export interface AccountRequest {
  kind: AccountOperation
  model?: string
  reasoningEffort?: string
  serviceTier?: string
  sessionId?: string
  accountKey?: string
  signal?: AbortSignal
}

/** Short-lived Host-only authentication. Never persist or return this through RPC. */
export interface AccountLease {
  accountKey: string
  accountId: string
  accessToken: string
  headers: Record<string, string>
  signal: AbortSignal
  /** Upstream model ID resolved from a Host capability alias. */
  model?: string
  /** Production leases observe quota hints; omitted test/provider leases leave responses unchanged. */
  observeResponse?(response: Response): Response
}

/** Validated deployment options, supplied by the plugin composition root. */
export interface AccountsOptions {
  credentials: Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>
  authorization: Pick<AuthorizationService, 'registerFlow' | 'begin' | 'cancel'>
  fetch: typeof globalThis.fetch
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  callbackPorts: readonly number[]
  loginTimeoutMs: number
  tokenTimeoutMs: number
  sessionAffinityLimit: number
  cooldownMs: number
  baseUrl: string
  clientVersion: string
  discoveryTtlMs: number
  modelSettings?: ModelSettings
  resolveClientVersion?(): Promise<string>
  now?: () => number
}

/** Stable integration surface shared by settings, tools and the local relay. */
export interface AccountsFacade {
  list(): Promise<readonly AccountView[]>
  getAccountStatus(accountKey: string, options?: AccountReadOptions): Promise<AccountView>
  getAccountQuota(accountKey: string, options?: AccountReadOptions): Promise<AccountUsage | undefined>
  refreshAccount(accountKey: string, signal?: AbortSignal): Promise<AccountView>
  beginLogin(): Promise<LoginView>
  loginStatus(loginId: string): LoginView
  completeLogin(loginId: string, callbackUrl: string): Promise<LoginView>
  cancelLogin(loginId: string): Promise<void>
  update(accountKey: string, patch: { label?: string; enabled?: boolean; allowCredits?: boolean; priority?: number; revision: number }): Promise<AccountView>
  remove(accountKey: string, revision: number): Promise<void>
  models(): Promise<readonly CodexModelView[]>
  modelRoutes(): Promise<readonly CodexModelRouteView[]>
  withAccount<T>(request: AccountRequest, operation: (lease: AccountLease) => Promise<T>): Promise<T>
}

/** Reads are local by default; fresh explicitly refreshes safe account metadata, never buys a quota reset. */
export interface AccountReadOptions { fresh?: boolean; signal?: AbortSignal }

/** Adapter integration keeps image attachment resolution in the established DSH seam. */
export interface PoolAdapterOptions {
  provider: string
  displayName: string
  baseUrl: string
  streamIdleTimeoutMs: number
  timeoutMs: number
  maxRequestImageBytes: number
  requestImagePixelBudget: number
  requestImageMaxBytes: number
  resolveAttachments?: PiAiAdapterOptions['resolveAttachments']
  resolveImageAccess?: PiAiAdapterOptions['resolveImageAccess']
}
