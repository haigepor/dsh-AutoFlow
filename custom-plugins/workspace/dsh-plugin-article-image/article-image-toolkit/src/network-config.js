/** Explicit network routes; proxy use never delegates destination validation to a proxy. */
import { z } from 'zod'

/** Network deployment settings shared by numbered text and rich capture. */
export const networkConfigSchema = z.object({
  proxyUrl: z.string().max(4096).refine(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash } catch (error) { void error; return false }
  }, 'Expected an HTTP(S) proxy without credentials, path or query').optional(),
  dnsProvider: z.enum(['system', 'cloudflare']).default('system'),
  maxDnsCacheEntries: z.number().int().min(1).max(10000).default(256),
  maxDnsCacheTtlMs: z.number().int().min(0).max(3600000).default(60000),
}).strict()
