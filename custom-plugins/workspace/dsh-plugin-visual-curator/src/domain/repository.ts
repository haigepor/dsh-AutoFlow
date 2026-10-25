/** Immutable dependencies become visible only through a durable aggregate manifest. */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { CuratorError } from '../shared/errors.ts'
import { recordSchema, jsonSchema, type CuratorRecord, type RecordKind, type RecordOf, type Json } from '../shared/model.ts'

/** @param value JSON-compatible content. @returns Versioned canonical SHA-256 digest. */
export function contentDigest(value: unknown): string {
  return `sha256-v1:${createHash('sha256').update(canonical(value)).digest('hex')}`
}
/** @param value Exact UTF-8 file content. @returns The file's versioned SHA-256 checksum. */
export function fileChecksum(value: string): string { return `sha256-v1:${createHash('sha256').update(value, 'utf8').digest('hex')}` }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  throw new CuratorError('invalid-input', 'digest', 'Content is not serializable JSON.')
}
const pointerSchema = z.strictObject({ key: z.string(), kind: z.string(), id: z.string(), digest: z.string() })
/** Final commit contains receipts so a failed response can be recovered after restart. */
export const manifestSchema = z.strictObject({ schemaVersion: z.literal(1), profileId: z.string(), aggregateId: z.string(), revision: z.number().int().positive(), records: z.array(pointerSchema), state: jsonSchema, receipts: z.record(z.string(), z.strictObject({ requestDigest: z.string(), revision: z.number().int().positive(), state: jsonSchema })) })
export type AggregateManifest = z.infer<typeof manifestSchema>

/** @param profileId Profile owning this domain. @returns Profile-isolated storage-domain declaration. */
export function curatorDomainSpecFor(profileId: string) {
  return defineDomain({ name: `visual_curator_${createHash('sha256').update(profileId).digest('hex').slice(0, 24)}`, version: 1, tables: { records: domainTable(recordSchema), manifests: domainTable(manifestSchema) } })
}
/** Default declaration for consumers whose host already isolates storage by profile. */
export const curatorDomainSpec = curatorDomainSpecFor('default')
type StorageHandle = Domain<ReturnType<typeof curatorDomainSpecFor>>

/** Adapter grants no bypass around the manifest visibility rule. */
export interface DomainAdapter {
  /** @param key Immutable physical key. @returns Stored dependency, including uncommitted objects. */
  readRecord(key: string): CuratorRecord | undefined
  /** @returns Current aggregate manifests. */
  manifests(): AggregateManifest[]
  /** @param key Immutable physical key. @param record Validated dependency. */
  writeRecord(key: string, record: CuratorRecord): Promise<void>
  /** @param manifest Single commit point. */
  writeManifest(manifest: AggregateManifest): Promise<void>
  /** @returns Completion after storage drains. */
  close(): Promise<void>
}
/** Production persistence over ctx.storageDomain. */
export class StorageDomainAdapter implements DomainAdapter {
  /** @param domain Opened profile-isolated domain. */
  constructor(private readonly domain: StorageHandle) {}
  readRecord(key: string): CuratorRecord | undefined { return this.domain.table('records').get(key) }
  manifests(): AggregateManifest[] { return [...this.domain.table('manifests').entries()].map(([, m]) => m) }
  async writeRecord(key: string, record: CuratorRecord): Promise<void> { await this.domain.table('records').put(key, record) }
  async writeManifest(manifest: AggregateManifest): Promise<void> { await this.domain.table('manifests').put(manifest.aggregateId, manifest) }
  close(): Promise<void> { return this.domain.close() }
}
/** Deterministic failure adapter; durable maps can be reused for simulated restarts. */
export class MemoryDomainAdapter implements DomainAdapter {
  readonly records = new Map<string, CuratorRecord>()
  readonly commits = new Map<string, AggregateManifest>()
  failNextManifest = false
  failNextRecord = false
  readRecord(key: string): CuratorRecord | undefined { return this.records.get(key) }
  manifests(): AggregateManifest[] { return [...this.commits.values()] }
  async writeRecord(key: string, record: CuratorRecord): Promise<void> {
    if (this.failNextRecord) { this.failNextRecord = false; throw new Error('Injected dependency write failure') }
    this.records.set(key, structuredClone(record))
  }
  async writeManifest(manifest: AggregateManifest): Promise<void> {
    if (this.failNextManifest) { this.failNextManifest = false; throw new Error('Injected manifest write failure') }
    this.commits.set(manifest.aggregateId, structuredClone(manifest))
  }
  async close(): Promise<void> {}
}
/** A single aggregate mutation; no dependency becomes visible until state commits. */
export interface CommitInput {
  aggregateId: string
  expectedRevision: number
  operationId: string
  request: unknown
  records: readonly CuratorRecord[]
  state: Json
}
/** Returned unchanged on an idempotent retry, even after subsequent edits. */
export interface CommitResult { revision: number; state: Json }

/** Serial aggregate writer; owns revision checks, request receipts and visibility. */
export class DomainRepository {
  private chain: Promise<void> = Promise.resolve()
  private closed = false
  private readScope: { pointers: Map<string, AggregateManifest['records'][number]>; records: Map<string, CuratorRecord | undefined> } | undefined
  /** @param profileId Owning profile. @param adapter Storage-domain or deterministic fixture. */
  constructor(readonly profileId: string, private readonly adapter: DomainAdapter) {
    for (const manifest of adapter.manifests()) {
      manifestSchema.parse(manifest)
      this.assertProfile(manifest.profileId)
      for (const pointer of manifest.records) {
        const record = adapter.readRecord(pointer.key)
        if (!record || contentDigest(record) !== pointer.digest) throw new CuratorError('reference-unavailable', 'storage-open', 'Committed data is missing or has changed.')
        recordSchema.parse(record)
        this.assertProfile(record.profileId)
      }
    }
  }
  /** @param aggregateId Aggregate identity. @returns Cloned current manifest or absence. */
  manifest(aggregateId: string): AggregateManifest | undefined { return structuredClone(this.adapter.manifests().find(m => m.aggregateId === aggregateId)) }
  /** @returns Cloned commit manifests for durable operation recovery. */
  manifests(): AggregateManifest[] { return structuredClone(this.adapter.manifests()) }
  /** Reuse verified records only during a synchronous read; caller mutations still receive independent clones.
   * @param read Synchronous projection with no writes or external callbacks.
   * @returns Projection result; nested reads share this scope and exceptions release it.
   */
  readSnapshot<T>(read: () => T): T {
    if (this.readScope) return read()
    const pointers = new Map<string, AggregateManifest['records'][number]>()
    for (const manifest of this.adapter.manifests()) for (const pointer of manifest.records) {
      const identity = `${pointer.kind}:${pointer.id}`
      if (!pointers.has(identity)) pointers.set(identity, pointer)
    }
    this.readScope = { pointers, records: new Map() }
    try { return read() } finally { this.readScope = undefined }
  }
  /** @param kind Record tag. @param id Logical record ID. @returns Only committed records. */
  get<K extends RecordKind>(kind: K, id: string): RecordOf<K> | undefined {
    if (this.readScope) {
      const identity = `${kind}:${id}`, { pointers, records } = this.readScope
      if (!records.has(identity)) {
        const pointer = pointers.get(identity)
        if (!pointer) return undefined
        const value = this.adapter.readRecord(pointer.key)
        if (!value || contentDigest(value) !== pointer.digest) throw new CuratorError('reference-unavailable', 'storage-read', 'Committed data is missing or has changed.')
        records.set(identity, value)
      }
      const value = records.get(identity)
      return value?.kind === kind ? structuredClone(value) as RecordOf<K> : undefined
    }
    for (const manifest of this.adapter.manifests()) {
      const pointer = manifest.records.find(p => p.kind === kind && p.id === id)
      if (!pointer) continue
      const value = this.adapter.readRecord(pointer.key)
      if (!value || contentDigest(value) !== pointer.digest) throw new CuratorError('reference-unavailable', 'storage-read', 'Committed data is missing or has changed.')
      if (value.kind === kind) return structuredClone(value) as RecordOf<K>
    }
    return undefined
  }
  /** @param kind Record tag. @returns Committed records in stable ID order. */
  list<K extends RecordKind>(kind: K): RecordOf<K>[] {
    const ids = new Set(this.readScope ? [...this.readScope.pointers.values()].filter(p => p.kind === kind).map(p => p.id) : this.adapter.manifests().flatMap(m => m.records.filter(p => p.kind === kind).map(p => p.id)))
    return [...ids].sort().map(id => this.get(kind, id)).filter((r): r is RecordOf<K> => r !== undefined)
  }
  /** @param input Complete aggregate mutation. @returns Original operation receipt after durability. */
  commit(input: CommitInput): Promise<CommitResult> {
    if (this.closed) return Promise.reject(new CuratorError('cancelled', 'storage-commit', 'The curator writer is closed.'))
    const work = this.chain.then(() => this.commitNow(input))
    this.chain = work.then(() => {}, () => {})
    return work
  }
  private async commitNow(input: CommitInput): Promise<CommitResult> {
    const requestDigest = contentDigest(input.request)
    // Receipt lookup precedes revision checks: a retry uses its original revision.
    for (const manifest of this.adapter.manifests()) {
      const receipt = manifest.receipts[input.operationId]
      if (!receipt) continue
      if (manifest.aggregateId !== input.aggregateId || receipt.requestDigest !== requestDigest) throw new CuratorError('operation-conflict', 'storage-commit', 'Operation ID was already used for different input.')
      return structuredClone({ revision: receipt.revision, state: receipt.state })
    }
    const current = this.manifest(input.aggregateId)
    if ((current?.revision ?? 0) !== input.expectedRevision) throw new CuratorError('revision-conflict', 'storage-commit', 'The record changed; refresh before saving.', { retryable: true })
    const parsed = input.records.map(record => recordSchema.parse(record))
    const state = jsonSchema.parse(input.state)
    const pointers = [...(current?.records ?? [])]
    const identities = new Set<string>()
    for (const record of parsed) {
      this.assertProfile(record.profileId)
      const identity = `${record.kind}:${record.id}`
      if (identities.has(identity)) throw new CuratorError('invalid-input', 'storage-commit', 'Duplicate record identity in one commit.')
      identities.add(identity)
      const previous = this.get(record.kind, record.id)
      if (previous && !['style', 'draft', 'feedbackThread', 'run', 'request', 'suggestion'].includes(record.kind) && contentDigest(previous) !== contentDigest(record)) throw new CuratorError('constraint-conflict', 'storage-commit', 'An immutable record cannot be replaced.')
      for (const other of this.adapter.manifests()) {
        if (other.aggregateId !== input.aggregateId && other.records.some(p => p.kind === record.kind && p.id === record.id)) throw new CuratorError('constraint-conflict', 'storage-commit', 'Record belongs to another aggregate.')
      }
      const digest = contentDigest(record)
      const key = `${record.kind}-${digest.slice(10)}`
      const oldIndex = pointers.findIndex(p => p.kind === record.kind && p.id === record.id)
      if (oldIndex >= 0) pointers.splice(oldIndex, 1)
      pointers.push({ key, kind: record.kind, id: record.id, digest })
    }
    const revision = input.expectedRevision + 1
    const manifest = manifestSchema.parse({ schemaVersion: 1, profileId: this.profileId, aggregateId: input.aggregateId, revision, records: pointers, state, receipts: { ...current?.receipts, [input.operationId]: { requestDigest, revision, state } } })
    try {
      for (let i = 0; i < parsed.length; i++) {
        const record = parsed[i]!
        const pointer = pointers.find(p => p.kind === record.kind && p.id === record.id)!
        if (!this.adapter.readRecord(pointer.key)) await this.adapter.writeRecord(pointer.key, record)
      }
      await this.adapter.writeManifest(manifest)
    } catch (cause) {
      throw new CuratorError('storage-commit-failed', 'storage-commit', 'The change was not committed; the previous state remains active.', { cause, retryable: true, suggestedAction: 'Retry with the same operation ID.' })
    }
    return { revision, state: structuredClone(state) }
  }
  /** @param profileId Record owner. */
  assertProfile(profileId: string): void { if (profileId !== this.profileId) throw new CuratorError('owner-denied', 'authorization', 'This record belongs to another profile.') }
  /** Stop admission, drain committed writes, then close the storage domain. */
  async close(): Promise<void> { this.closed = true; await this.chain; await this.adapter.close() }
}

/** @param lockPath Profile-private file path. @returns Lifecycle disposer after exclusive acquisition. */
export async function acquireProfileWriter(lockPath: string): Promise<() => Promise<void>> {
  const absolute = resolve(lockPath)
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
  let release!: () => void
  let acquired!: () => void
  let failed!: (error: unknown) => void
  const released = new Promise<void>(resolveRelease => { release = resolveRelease })
  const ready = new Promise<void>((resolveReady, rejectReady) => { acquired = resolveReady; failed = rejectReady })
  const holding = withFileLock(absolute, async () => { acquired(); await released }, { waitMs: 0 })
  void holding.catch(cause => failed(new CuratorError('writer-occupied', 'storage-open', 'Another Visual Curator Host owns this profile.', { cause, suggestedAction: 'Stop the other Host and try again.' })))
  await ready
  return async () => { release(); await holding }
}
/** Acquire the writer before opening a second storage cache. */
export async function openCuratorRepository(options: { profileId: string; facility: Pick<DomainFacility, 'open'>; lockPath: string }): Promise<{ repository: DomainRepository; close: () => Promise<void> }> {
  const release = await acquireProfileWriter(options.lockPath)
  try {
    const handle = await options.facility.open(curatorDomainSpecFor(options.profileId))
    let repository: DomainRepository
    try { repository = new DomainRepository(options.profileId, new StorageDomainAdapter(handle)) }
    catch (error) { await handle.close(); throw error }
    return { repository, close: async () => { try { await repository.close() } finally { await release() } } }
  } catch (error) { await release(); throw error }
}
