/** Read saved image choices without automatic discovery or image-generation probes. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { officialImageModelSchema, imageCheckStateSchema, type ImageCatalogView } from '../shared/image-catalog.ts'
import type { SubscriptionOptions } from './config.ts'
import type { AccountsFacade } from './accounts/types.ts'
import type { ImageService } from './images/service.ts'
import type { ImageTask } from './images/types.ts'

const sourceUrl = 'https://developers.openai.com/api/docs/models'
type CatalogKey = Branded<'CodexImageCatalogKey'>
const stateKey = brandString<CatalogKey>('catalog')
const probeSchema = z.strictObject({ accountKey: z.string(), modelId: z.string(), operationId: z.string(), createdAt: z.number(),
  taskId: z.string().optional(), state: imageCheckStateSchema, checkedAt: z.number().optional(), errorCode: z.string().optional() })
const storedSchema = z.strictObject({ models: z.array(officialImageModelSchema), probes: z.array(probeSchema), fetchedAt: z.number().optional(), attemptedAt: z.number().optional(), errorCode: z.string().optional() })
type Stored = z.infer<typeof storedSchema>
type Probe = z.infer<typeof probeSchema>
type Options = SubscriptionOptions['imageDiscovery']

/** Admit only official model-page links, excluding scripts, foreign origins and dated snapshots.
 * @param html Bounded official index HTML.
 * @returns Unique image model IDs published in the index.
 */
export function parseOfficialImageModels(html: string): Stored['models'] {
  const models = new Map<string, Stored['models'][number]>()
  for (const match of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    let url: URL
    try { url = new URL(match[1]!, sourceUrl) } catch (_error) { continue /* Malformed links are not model entries. */ }
    const id = /^\/api\/docs\/models\/(gpt-image-\d+(?:\.\d+)?(?:-[a-z][a-z0-9]*)*)\/?$/.exec(url.pathname)?.[1]
    if (url.origin !== 'https://developers.openai.com' || url.search || url.hash || !id) continue
    models.set(id, { id, name: id, url: url.href })
  }
  if (!models.size || models.size > 64) throw new Error('OFFICIAL_IMAGE_CATALOG_INVALID')
  return [...models.values()]
}

/** A successful invalid-ID control or ignored output size cannot establish model access.
 * @param task Existing terminal receipt.
 * @param control Whether the requested ID deliberately does not exist.
 * @returns Conservative verification state and a stable diagnostic code.
 */
export function imageProbeVerdict(task: ImageTask, control: boolean): Pick<Probe, 'state' | 'errorCode'> {
  if (task.state === 'outcome-unknown' || task.state === 'cancelled') return { state: 'outcome-unknown', errorCode: 'IMAGE_PROBE_OUTCOME_UNKNOWN' }
  if (control) return task.state === 'failed' && [400, 404].includes(task.error?.status ?? 0) ? { state: 'verified' }
    : task.state === 'succeeded' ? { state: 'indeterminate', errorCode: 'IMAGE_MODEL_PARAMETER_UNVERIFIED' } : { state: 'blocked', errorCode: task.error?.code ?? 'IMAGE_PROBE_UNAVAILABLE' }
  if (task.state === 'succeeded' && task.assets.length) {
    const image = task.assets[0]!.preview, dimensions = image.originalDimensions ?? image
    return dimensions.width === 1024 && dimensions.height === 1024 ? { state: 'verified' } : { state: 'indeterminate', errorCode: 'IMAGE_PROBE_SIZE_MISMATCH' }
  }
  return { state: [400, 403, 404].includes(task.error?.status ?? 0) ? 'rejected' : 'blocked', errorCode: task.error?.code ?? 'IMAGE_PROBE_UNAVAILABLE' }
}

/** Open saved model choices without network requests, account checks or generated test images.
 * @param dependencies Existing storage owner; legacy scheduling settings never start background work.
 * @returns Read-only cached choices; old probe receipts remain unchanged in storage.
 */
export async function openImageCatalog(dependencies: {
  storage: Pick<DomainFacility, 'open'>; domainName: string; accounts: Pick<AccountsFacade, 'list' | 'getAccountStatus'>;
  images: Pick<ImageService, 'submitProbe' | 'getResult' | 'list'>; fetch: typeof fetch; options(): Options; pollIntervalMs(): number;
  signal: AbortSignal; reportError(): void; now?: () => number;
}) {
  const domain = await dependencies.storage.open(defineDomain({ name: dependencies.domainName, version: 1, tables: { state: domainTable<CatalogKey, Stored>(storedSchema) } }))
  const saved = structuredClone(domain.table('state').get(stateKey) ?? { models: [], probes: [] })
  return {
    read(): ImageCatalogView {
      return { sourceUrl, autoProbe: false, pollIntervalMs: dependencies.pollIntervalMs(), status: saved.fetchedAt === undefined ? 'idle' : 'ready',
        ...(saved.fetchedAt === undefined ? {} : { checkedAt: saved.fetchedAt }), entries: saved.models.map(model => ({ ...model, checks: [] })) }
    },
    models() { return structuredClone(saved.models) },
    async close() { await domain.close() },
  }
}
