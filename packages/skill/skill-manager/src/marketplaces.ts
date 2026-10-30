/** Bounded adapters for fixed public marketplace endpoints. */
import { z } from 'zod'
import { ManagementError } from './files.ts'
import { decodeArchive } from './repositories.ts'
import type { MarketplaceSkill, SkillImportFile } from './types.ts'

/** Read a fixed service endpoint within a byte and time limit.
 *
 * @param url - internally constructed public service URL.
 * @param maxBytes - byte bound.
 * @param timeoutMs - deadline.
 *
 * @returns response bytes, or a typed rejection.

 */
async function download(url: URL, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok || response.body === null) throw new ManagementError('network')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        total += chunk.value.length
        if (total > maxBytes) throw new ManagementError('too-large')
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  } catch (error) {
    if (error instanceof ManagementError) throw error
    throw new ManagementError('network')
  }
}
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)
const skillsSh = z.object({
  source: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
  skillId: identifier,
  name: z.string().max(256),
})
const claw = z.object({
  slug: identifier,
  displayName: z.string().max(256).optional(),
  summary: z.string().max(8192).optional(),
  ownerHandle: identifier.optional(),
  owner: z.object({ handle: identifier }).optional(),
})

/** Search skills.sh or search/browse ClawHub without loading any instructions.
 *
 * @param catalog - fixed service.
 * @param query - search text; empty ClawHub query reads the download list.
 *
 * @param timeoutMs - network deadline.
 * @returns validated discovery entries.

 */
export async function marketplaceSearch(
  catalog: MarketplaceSkill['catalog'],
  query: string,
  timeoutMs: number,
): Promise<MarketplaceSkill[]> {
  if (query.length > 100) throw new ManagementError('invalid')
  const url = new URL(
    catalog === 'skills.sh'
      ? 'https://skills.sh/api/search'
      : query.trim()
        ? 'https://clawhub.ai/api/v1/search'
        : 'https://clawhub.ai/api/v1/skills',
  )
  url.searchParams.set('limit', '30')
  if (query.trim()) url.searchParams.set('q', query.trim())
  else if (catalog === 'clawhub') url.searchParams.set('sort', 'downloads')
  else throw new ManagementError('invalid')
  const payload = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(new TextDecoder().decode(await download(url, 1024 * 1024, timeoutMs))))
  const entries = z
    .array(z.unknown())
    .parse(payload[catalog === 'skills.sh' ? 'skills' : query.trim() ? 'results' : 'items'])
  const result: MarketplaceSkill[] = []
  for (const entry of entries.slice(0, 100)) {
    if (catalog === 'skills.sh') {
      const parsed = skillsSh.safeParse(entry)
      if (parsed.success)
        result.push({
          catalog,
          owner: parsed.data.source.slice(0, parsed.data.source.indexOf('/')),
          slug: parsed.data.skillId,
          name: parsed.data.name,
          description: parsed.data.source,
          repository: parsed.data.source,
        })
    } else {
      const parsed = claw.safeParse(entry)
      if (parsed.success) {
        const owner = parsed.data.ownerHandle ?? parsed.data.owner?.handle
        if (owner !== undefined)
          result.push({
            catalog,
            owner,
            slug: parsed.data.slug,
            name: parsed.data.displayName ?? parsed.data.slug,
            description: parsed.data.summary ?? '',
            repository: '',
          })
      }
    }
  }
  return result.slice(0, 30)
}
/** Fetch an explicitly selected marketplace skill as ordinary import members.
 *
 * @param skill - validated discovery identity.
 * @param maxBytes - payload bound.
 * @param maxFiles - expanded member bound.
 * @param timeoutMs - deadline.
 *
 * @returns relative files; the common importer validates instructions and paths.

 */
export async function marketplaceFiles(
  skill: MarketplaceSkill,
  maxBytes: number,
  maxFiles: number,
  timeoutMs: number,
): Promise<SkillImportFile[]> {
  identifier.parse(skill.owner)
  identifier.parse(skill.slug)
  if (skill.catalog === 'clawhub') {
    const url = new URL('https://clawhub.ai/api/v1/download')
    url.searchParams.set('owner', skill.owner)
    url.searchParams.set('slug', skill.slug)
    return Object.entries(decodeArchive(await download(url, maxBytes, timeoutMs), maxBytes, maxFiles)).map(
      ([path, bytes]) => ({ path, base64: Buffer.from(bytes).toString('base64') }),
    )
  }
  if (!/^[\w.-]+\/[\w.-]+$/u.test(skill.repository) || skill.repository.split('/')[0] !== skill.owner)
    throw new ManagementError('invalid')
  const url = new URL(
    `https://skills.sh/api/download/${skill.repository.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(skill.slug)}`,
  )
  const payload = z
    .object({ files: z.array(z.object({ path: z.string(), contents: z.string() })).max(maxFiles) })
    .parse(JSON.parse(new TextDecoder().decode(await download(url, maxBytes, timeoutMs))))
  return payload.files.map(file => ({ path: file.path, base64: Buffer.from(file.contents, 'utf8').toString('base64') }))
}
