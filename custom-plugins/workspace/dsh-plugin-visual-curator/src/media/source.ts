import { invalidInput, MediaError } from './errors.ts'
import type { HttpClient, RequestBounds } from './network.ts'

/** Restricted request field names; values come only from the fixed query and returned cursor. */
export interface SourceRequestMapping { query: string; cursor: string; pageSize: string; language?: string; filter?: string }
/** RFC 6901 pointers, relative to the full response for items/cursor and each item for other fields. */
export interface SourceResponseMapping { items: string; id: string; previewUrl: string; nextCursor: string; originalUrl?: string; width?: string; height?: string }
/** An optional stable-ID endpoint refreshes ephemeral media locations without restarting search. */
export interface SourceLookupConfig { endpoint: string; method: 'GET' | 'POST'; idField: string; response: Omit<SourceResponseMapping, 'items' | 'nextCursor'> }
/** Immutable deployment configuration; credentials are passed separately and never returned. */
export interface SourceConfig { endpoint: string; method: 'GET' | 'POST'; request: SourceRequestMapping; response: SourceResponseMapping; maxPageSize: number; lookup?: SourceLookupConfig }
/** Keyword query fixed by the RunSpec. */
export interface SourceQuery { query: string; pageSize: number; language?: string; filter?: string }
/** Ephemeral locations must never be written into durable business records or logs. */
export interface SourceLocation { previewUrl: string; originalUrl?: string }
/** Stable identity and optional provider-declared dimensions; dimensions are not pixel proof. */
export interface SourceItem extends SourceLocation { providerAssetId: string; width?: number; height?: number }
/** One real source page; null means normal exhaustion. */
export interface SourcePage { items: SourceItem[]; nextCursor: string | null }

function protocol(message: string, continuation = false): MediaError {
  return new MediaError(continuation ? 'source-continuation-invalid' : 'source-protocol-error', 'retrieving', false, message, continuation ? 'Start a new search explicitly; the saved continuation cannot be replaced.' : 'Correct the source field mappings or response and start a new search.')
}

function configuredUrl(value: string): void {
  let url: URL
  try { url = new URL(value) } catch (error) {
    if (error instanceof Error) throw invalidInput('A valid source endpoint is required.')
    throw invalidInput('A valid source endpoint is required.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw invalidInput('Source endpoints must be configured HTTPS URLs without embedded credentials.')
}

function pointerParts(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) throw invalidInput('Source response mappings must be RFC 6901 JSON Pointers.')
  return pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
}

/** Read a JSON Pointer without evaluating expressions or inherited properties.
 * @param value Parsed response JSON.
 * @param pointer Validated RFC 6901 pointer.
 * @returns The selected value, or undefined for an absent field.
 */
export function readJsonPointer(value: unknown, pointer: string): unknown {
  let selected = value
  for (const part of pointerParts(pointer)) {
    if (typeof selected !== 'object' || selected === null || !Object.hasOwn(selected, part)) return undefined
    selected = Reflect.get(selected, part)
  }
  return selected
}

function requiredString(value: unknown, label: string, maxLength = 4096): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) throw protocol(`The source ${label} field is missing or invalid.`)
  return value
}

function mediaUrl(value: unknown): string {
  const raw = requiredString(value, 'media URL', 16384)
  let url: URL
  try { url = new URL(raw) } catch (error) {
    if (error instanceof Error) throw protocol('The source returned an invalid media location.')
    throw protocol('The source returned an invalid media location.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw protocol('The source returned an unsupported media location.')
  return url.href
}

/** Configurable JSON source with real cursor validation and one request per operation. */
export class SourceHttpProvider {
  readonly config: SourceConfig
  constructor(config: SourceConfig, private readonly http: HttpClient, private readonly headers: Readonly<Record<string, string>> = {}) {
    this.config = structuredClone(config)
    configuredUrl(config.endpoint)
    if (!['GET', 'POST'].includes(config.method) || !Number.isSafeInteger(config.maxPageSize) || config.maxPageSize <= 0) throw invalidInput('Source method and maximum page size must be configured.')
    for (const name of Object.values(config.request)) if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) throw invalidInput('Source request mappings must be simple field names.')
    if (new Set(Object.values(config.request)).size !== Object.values(config.request).length) throw invalidInput('Source request mappings must use distinct field names.')
    for (const key of ['query', 'cursor', 'pageSize'] as const) if (!config.request[key]) throw invalidInput('The source request mapping is incomplete.')
    for (const key of ['items', 'id', 'previewUrl', 'nextCursor'] as const) if (typeof config.response[key] !== 'string') throw invalidInput('The source response mapping is incomplete.')
    for (const pointer of Object.values(config.response)) pointerParts(pointer)
    if (config.lookup !== undefined) {
      configuredUrl(config.lookup.endpoint)
      if (!['GET', 'POST'].includes(config.lookup.method) || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(config.lookup.idField)) throw invalidInput('The source lookup request mapping is invalid.')
      for (const key of ['id', 'previewUrl'] as const) if (typeof config.lookup.response[key] !== 'string') throw invalidInput('The source lookup response mapping is incomplete.')
      for (const pointer of Object.values(config.lookup.response)) pointerParts(pointer)
    }
  }

  /** Retrieve one bounded page; first-page null omits the cursor field entirely.
   * @param query Fixed keywords, optional language/filter and a positive requested page size.
   * @param cursor Previously committed cursor; null requests the first page.
   * @param bounds Reserved attempt limits, plus every committed cursor to reject loops.
   * @returns Stable items and a real next cursor; media locations remain ephemeral.
   */
  async search(query: SourceQuery, cursor: string | null, bounds: RequestBounds & { seenCursors?: readonly string[] }): Promise<SourcePage> {
    if (!query.query.trim() || query.query.length > 4096 || !Number.isSafeInteger(query.pageSize) || query.pageSize <= 0 || query.pageSize > this.config.maxPageSize) throw invalidInput('The search query or page size is invalid.')
    if (cursor !== null && (!cursor.trim() || cursor.length > 8192)) throw protocol('The saved source continuation is invalid.', true)
    const mapping = this.config.request
    if (query.language !== undefined && mapping.language === undefined || query.filter !== undefined && mapping.filter === undefined) throw invalidInput('The source does not map the requested language or filter.')
    const fields: Record<string, string | number> = { [mapping.query]: query.query, [mapping.pageSize]: query.pageSize }
    if (cursor !== null) fields[mapping.cursor] = cursor
    if (query.language !== undefined && mapping.language !== undefined) fields[mapping.language] = query.language
    if (query.filter !== undefined && mapping.filter !== undefined) fields[mapping.filter] = query.filter
    let json: unknown
    try { json = await this.request(this.config.endpoint, this.config.method, fields, bounds) } catch (error) {
      if (cursor !== null && error instanceof MediaError && error.code === 'remote-request-failed' && !error.retryable) throw protocol('The source refused the saved continuation.', true)
      throw error
    }
    const items = readJsonPointer(json, this.config.response.items)
    const next = readJsonPointer(json, this.config.response.nextCursor)
    if (!Array.isArray(items) || items.length > query.pageSize) throw protocol('The source items field is absent or exceeds the requested page size.')
    if (next !== null && (typeof next !== 'string' || next.trim().length === 0 || next.length > 8192 || next === cursor || bounds.seenCursors?.includes(next))) throw protocol('The source returned an empty, repeated or invalid next cursor.')
    const parsed = items.map(item => this.parseItem(item, this.config.response))
    if (new Set(parsed.map(item => item.providerAssetId)).size !== parsed.length) throw protocol('The source page repeats a stable asset identifier.')
    return { items: parsed, nextCursor: next }
  }

  /** Refresh media by stable ID without falling back to the first search page.
   * @param providerAssetId Previously committed source identity.
   * @param bounds Reserved single-attempt limits.
   * @returns Refreshed ephemeral media locations, checked to retain the requested identity.
   */
  async lookup(providerAssetId: string, bounds: RequestBounds): Promise<SourceItem> {
    if (this.config.lookup === undefined) throw new MediaError('media-unavailable', 'retrieving', false, 'This source cannot refresh an expired media location.', 'Start a new search explicitly or use already saved image bytes.')
    if (!providerAssetId.trim() || providerAssetId.length > 1024) throw invalidInput('A stable provider asset ID is required.')
    const lookup = this.config.lookup
    const json = await this.request(lookup.endpoint, lookup.method, { [lookup.idField]: providerAssetId }, bounds)
    const item = this.parseItem(json, lookup.response)
    if (item.providerAssetId !== providerAssetId) throw protocol('The media lookup returned a different source asset.')
    return item
  }

  private parseItem(value: unknown, mapping: Omit<SourceResponseMapping, 'items' | 'nextCursor'>): SourceItem {
    const item: SourceItem = { providerAssetId: requiredString(readJsonPointer(value, mapping.id), 'stable ID', 1024), previewUrl: mediaUrl(readJsonPointer(value, mapping.previewUrl)) }
    if (mapping.originalUrl !== undefined) {
      const original = readJsonPointer(value, mapping.originalUrl)
      if (original !== undefined && original !== null) item.originalUrl = mediaUrl(original)
    }
    for (const name of ['width', 'height'] as const) {
      const pointer = mapping[name]
      if (pointer === undefined) continue
      const dimension = readJsonPointer(value, pointer)
      if (dimension !== undefined && dimension !== null) {
        if (typeof dimension !== 'number' || !Number.isSafeInteger(dimension) || dimension <= 0) throw protocol('The source returned an invalid declared image dimension.')
        item[name] = dimension
      }
    }
    return item
  }

  private async request(endpoint: string, method: 'GET' | 'POST', fields: Record<string, string | number>, bounds: RequestBounds): Promise<unknown> {
    const url = new URL(endpoint)
    const headers: Record<string, string> = { ...this.headers, accept: 'application/json' }
    let body: Buffer | undefined
    if (method === 'GET') for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, String(value))
    else { headers['content-type'] = 'application/json'; body = Buffer.from(JSON.stringify(fields)) }
    const response = await this.http.request(url.href, { ...bounds, method, headers, body })
    if (response.status < 200 || response.status >= 300) throw protocol('The source returned a non-success status.')
    if (!/^(application\/json|application\/[A-Za-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers['content-type'] ?? '')) throw protocol('The source did not return JSON content.')
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)) } catch (error) {
      if (error instanceof Error) throw protocol('The source returned invalid JSON.')
      throw protocol('The source returned invalid JSON.')
    }
  }
}
