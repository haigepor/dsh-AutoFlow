/** Owner-authorized management operations and safe account/task metadata. */
import { z } from 'zod'
import { accountViewSchema } from './accounts.ts'

export const loginSchema = z.object({
  loginId: z.string(), state: z.enum(['waiting', 'exchanging', 'authorized', 'cancelled', 'failed']),
  authorizationUrl: z.string().url(), redirectUri: z.string(), expiresAt: z.number(), error: z.string().optional(),
})
export const snapshotSchema = z.object({
  accounts: z.array(accountViewSchema),
  models: z.array(z.object({ id: z.string(), name: z.string(), contextWindow: z.number().optional(), maxContextWindow: z.number().optional(),
    maxTokens: z.number().optional(), input: z.array(z.enum(['text', 'image'])).optional(), reasoningEfforts: z.array(z.string()).optional(),
    defaultReasoningEffort: z.string().optional(), serviceTiers: z.array(z.string()).optional() })),
  protocol: z.object({ upstream: z.object({ mode: z.enum(['auto', 'sse']), activeSockets: z.number(), websocketRequests: z.number(), httpFallbacks: z.number(),
    shunnedUntil: z.number(), largeMessageThreshold: z.number().optional(), largeMessageUntil: z.number().optional() }),
    version: z.object({ effective: z.string(), configured: z.string(), installed: z.string().optional(), cached: z.string().optional(), client: z.string().optional() }) }),
  tasks: z.array(z.object({
    id: z.string(), state: z.enum(['queued', 'sent', 'succeeded', 'failed', 'cancelled', 'outcome-unknown']), prompt: z.string(), model: z.string(), createdAt: z.number(),
    assets: z.array(z.object({ id: z.string(), previewUrl: z.string(), downloadUrl: z.string(), width: z.number(), height: z.number() })),
    errorCode: z.string().optional(),
  })),
  taskCount: z.number(), revision: z.number(),
  configuration: z.object({ imageModel: z.string(), imageTimeoutMs: z.number(), relayEnabled: z.boolean(), relayHost: z.enum(['127.0.0.1', '::1']), relayPort: z.number() }),
  relay: z.object({ state: z.enum(['stopped', 'running', 'error']), origin: z.string().optional(), errorCode: z.string().optional(), keyConfigured: z.boolean(), keyId: z.string().optional() }),
})
export type ManagementSnapshot = z.infer<typeof snapshotSchema>
export type ManagementLogin = z.infer<typeof loginSchema>

/** Persisted changes carry the settings revision rather than overwriting another editor. */
export const configureSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  imageModel: z.string().min(1).max(128), imageTimeoutMs: z.number().int().min(1000).max(3_600_000),
  relayEnabled: z.boolean(), relayPort: z.number().int().min(1).max(65535),
})
export type ConfigureInput = z.infer<typeof configureSchema>

/** Only known operations can reach the authenticated management surface. */
export const managementSchema = z.strictObject({
  operation: z.enum(['snapshot', 'account-list', 'account-status', 'account-quota', 'account-refresh', 'model-list', 'model-routes', 'protocol-status', 'login-start', 'login-status', 'login-complete', 'login-cancel', 'account-update', 'account-remove',
    'configure', 'model-catalog', 'model-catalog-save', 'gateway-create', 'gateway-revoke', 'relay-test', 'image-submit', 'image-result', 'image-cancel', 'image-session-view', 'history-prune']),
  args: z.record(z.string(), z.unknown()).default({}),
})
export type ManagementOperation = z.infer<typeof managementSchema>['operation']
