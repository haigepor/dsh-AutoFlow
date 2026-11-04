/** Owner-scoped, frozen package projections without image-workspace reads. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CuratorDomain } from '../domain/curator.ts'
import { ModelProfiles, profileExportIdentity } from '../domain/model-profile.ts'
import { contentDigest, fileChecksum, type DomainRepository } from '../domain/repository.ts'
import { CuratorError } from '../shared/errors.ts'
import { modelProfileSchema, ruleSchema, type DomainActor, type ModelProfile, type ProfileExport, type RunRecord } from '../shared/model.ts'
import { datasetProgressSchema, datasetListInputSchema, datasetDetailInputSchema, datasetScopeSchema, datasetRoleCounts, type DatasetId, type DatasetPageToken, type DatasetEntry, type DatasetList, type DatasetDetail } from '../shared/datasets.ts'
import { dataOf, specOf, type RunEngine } from './runtime.ts'
import { hiddenTaskIds } from './task-history.ts'

type Saved = { key: 'run'; run: RunRecord; profile: ModelProfile; artifact?: ProfileExport } | { key: 'artifact'; profile: ModelProfile; artifact: ProfileExport }
const entryId = (saved: Saved): DatasetId => brandString<DatasetId>(saved.key === 'run' ? saved.run.id : saved.artifact.id)
const stamp = (saved: Saved): string => saved.artifact?.createdAt ?? (saved.key === 'run' ? saved.run.createdAt : saved.artifact.createdAt)
const unavailable = () => new CuratorError('owner-denied', 'dataset-read', 'This dataset is unavailable to the current owner.')

/** Independent directory records may be shared by related projections within one synchronous read. */
export interface DatasetDirectory { profiles: readonly ModelProfile[]; artifacts: readonly ProfileExport[] }

/** @param domain Committed package owner. @returns Verified, independent directory records; callers must not retain them beyond the current synchronous read. */
export function readDatasetDirectory(domain: CuratorDomain): DatasetDirectory {
  return domain.repository.readSnapshot(() => ({ profiles: domain.repository.list('modelProfile'), artifacts: domain.repository.list('profileExport') }))
}

function records(domain: CuratorDomain, engine: RunEngine, actor: DomainActor, directory?: DatasetDirectory): Saved[] {
  domain.repository.assertProfile(actor.profileId)
  const committed = directory ?? readDatasetDirectory(domain)
  const profiles = new Map<string, ModelProfile>(committed.profiles.map(profile => [profile.id, profile]))
  const artifacts = committed.artifacts.filter(record => profiles.has(record.modelProfileId))
  const used = new Set<string>(), hidden = hiddenTaskIds(domain.repository), rows: Saved[] = []
  for (const run of domain.repository.list('run')) {
    if (hidden.has(run.id) || run.profileId !== actor.profileId || (run.owner.kind === 'session' ? run.owner.sessionId !== actor.sessionId : actor.kind !== 'human')) continue
    const spec = specOf(run)
    if (spec.kind !== 'export' || typeof spec.input.modelProfileId !== 'string') continue
    const profile = profiles.get(spec.input.modelProfileId)
    if (!profile) continue
    engine.authorize(run, actor)
    const operationId = z.string().min(1).parse(spec.input.operationId)
    const resultIds = new Set(dataOf(run).resultIds), expectedArtifact = profileExportIdentity(operationId)
    const artifact = artifacts.find(record => resultIds.has(record.id) || record.id === expectedArtifact)
    if (artifact) used.add(artifact.id)
    rows.push({ key: 'run', run, profile, ...(artifact ? { artifact } : {}) })
  }
  for (const artifact of artifacts) if (!used.has(artifact.id)) rows.push({ key: 'artifact', artifact, profile: profiles.get(artifact.modelProfileId)! })
  return rows.sort((left, right) => stamp(right).localeCompare(stamp(left)) || entryId(right).localeCompare(entryId(left)))
}

function savedDataset(domain: CuratorDomain, engine: RunEngine, actor: DomainActor, id: string): Saved {
  domain.repository.assertProfile(actor.profileId)
  const artifact = domain.repository.get('profileExport', id)
  if (artifact) {
    const profile = domain.repository.get('modelProfile', artifact.modelProfileId)
    if (!profile) throw unavailable()
    domain.require('style', profile.styleId)
    return { key: 'artifact', artifact, profile }
  }
  const run = domain.repository.get('run', id)
  if (!run || hiddenTaskIds(domain.repository).has(id) || run.profileId !== actor.profileId || (run.owner.kind === 'session' ? run.owner.sessionId !== actor.sessionId : actor.kind !== 'human')) throw unavailable()
  engine.authorize(run, actor)
  const spec = specOf(run)
  if (spec.kind !== 'export' || typeof spec.input.modelProfileId !== 'string') throw unavailable()
  const profile = domain.repository.get('modelProfile', spec.input.modelProfileId)
  if (!profile) throw unavailable()
  const operationId = z.string().min(1).parse(spec.input.operationId)
  let saved: ProfileExport | undefined
  for (const artifactId of new Set([...dataOf(run).resultIds, profileExportIdentity(operationId)])) {
    const candidate = domain.repository.get('profileExport', artifactId)
    if (candidate && candidate.modelProfileId === profile.id) { saved = candidate; break }
  }
  return { key: 'run', run, profile, ...(saved ? { artifact: saved } : {}) }
}

function entry(domain: CuratorDomain, saved: Saved, cache?: DatasetReads): DatasetEntry {
  const { profile, artifact } = saved, run = saved.key === 'run' ? saved.run : undefined
  const progress = run ? datasetProgressSchema.safeParse(dataOf(run).checkpoint.datasetExportProgress) : undefined
  const error = run ? dataOf(run).error : undefined
  const sampleScope = datasetScopeSchema.parse(artifact?.sampleScope ?? (run ? specOf(run).input.sampleScope : undefined) ?? 'all')
  const references = profile.references.filter(ref => sampleScope === 'all' || ref.reference.role === sampleScope), complete = sampleScope === 'all'
  return { id: entryId(saved), ...(run ? { runId: run.id } : {}), ...(artifact ? { exportId: artifact.id, downloadPath: `/api/visual-curator/resource?exportId=${encodeURIComponent(artifact.id)}`, byteLength: cache ? cache.byteLength(artifact, domain.repository) : packageByteLength(artifact) } : {}),
    styleId: profile.styleId, name: domain.require('style', profile.styleId).name, modelProfileId: profile.id, profileRevision: profile.revision, model: profile.model, contentDigest: profile.contentDigest, sampleScope,
    createdAt: stamp(saved), status: artifact ? 'completed' : run!.status,
    ...(progress?.success ? { progress: progress.data } : {}), ...(error && !artifact ? { error } : {}),
    counts: { references: references.length, ...datasetRoleCounts(references.map(ref => ref.reference)), rules: complete ? profile.rules.length : 0, candidates: complete ? profile.options.length : 0, groups: complete ? profile.groups.length : 0, enabledGroups: complete ? profile.groups.filter(group => profile.options.some(option => option.enabled && option.groupId === group.groupId)).length : 0, files: artifact?.files.length ?? 0 },
  }
}

const cursorSchema = z.strictObject({ id: z.string(), scope: z.string() })
function offset(token: DatasetPageToken | undefined, scope: string, ids: readonly string[]): number {
  if (!token) return 0
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))), index = ids.indexOf(cursor.id)
    if (cursor.scope !== scope || index < 0) throw new Error('invalid-cursor')
    return index + 1
  } catch (cause) { throw new CuratorError('invalid-input', 'dataset-page', 'The dataset page is no longer available. Refresh the list.', { cause }) }
}
const continuation = (id: string, scope: string): DatasetPageToken => brandString<DatasetPageToken>(Buffer.from(JSON.stringify({ id, scope }), 'utf8').toString('base64url'))

/** @param domain Committed records. @param engine Run authorization. @param actor Current owner. @param args Untrusted UI query. @param pageSize Configured page length. @param cache Optional service-owned size reuse after current record checks. @param directory Optional records already verified during this synchronous read. @returns A lightweight, scope-bound page. */
export function listDatasets(domain: CuratorDomain, engine: RunEngine, actor: DomainActor, args: unknown, pageSize: number, cache?: DatasetReads, directory?: DatasetDirectory): DatasetList {
  return domain.repository.readSnapshot(() => {
    const input = datasetListInputSchema.parse(args)
    domain.require('style', input.styleId)
    const committed = directory ?? readDatasetDirectory(domain)
    const all = records(domain, engine, actor, committed).filter(saved => saved.profile.styleId === input.styleId)
    const profiles = new ModelProfiles(domain), current = profiles.current(input.styleId, actor, committed.profiles)
    const final = all.find(saved => saved.artifact && (!saved.artifact.sampleScope || saved.artifact.sampleScope === 'all') && saved.profile.id === current?.id) ?? all.find(saved => saved.artifact && (!saved.artifact.sampleScope || saved.artifact.sampleScope === 'all'))
    const ordered = final ? [final, ...all.filter(saved => saved !== final)] : all
    const filtered = ordered.filter(saved => {
      if (input.modelProfileId && saved.profile.id !== input.modelProfileId) return false
      if (input.reusableOnly && (!saved.artifact || saved.artifact.sampleScope && saved.artifact.sampleScope !== 'all')) return false
      const status = saved.artifact ? 'completed' : saved.key === 'run' ? saved.run.status : 'completed'
      const matches = input.status === 'all' || input.status === 'completed' && status === 'completed' || input.status === 'failed' && ['failed', 'interrupted', 'cancelled'].includes(status) || input.status === 'active' && ['created', 'running', 'pausing', 'paused', 'cancelling'].includes(status)
      const query = input.query.trim().toLocaleLowerCase()
      return matches && (!query || `${domain.require('style', saved.profile.styleId).name} ${saved.profile.model} ${entryId(saved)} ${saved.artifact?.id ?? ''}`.toLocaleLowerCase().includes(query))
    })
    const scope = JSON.stringify([actor.profileId, actor.sessionId ?? null, input.styleId, input.status, input.query, ...(input.modelProfileId || input.reusableOnly ? [input.modelProfileId ?? null, input.reusableOnly] : [])]), start = offset(input.pageToken, scope, filtered.map(entryId)), window = filtered.slice(start, start + pageSize)
    return { styleId: input.styleId, total: filtered.length, allTotal: all.length, entries: window.map(saved => ({ ...entry(domain, saved, cache), ...(saved === final ? { isFinal: true, stale: saved.profile.id !== current?.id || !profiles.isFresh(saved.profile, actor) } : {}) })), ...(start + pageSize < filtered.length ? { nextPageToken: continuation(entryId(window.at(-1)!), scope) } : {}) }
  })
}

const profileFileSchema = z.object({ modelSummary: z.object({ summary: z.string() }), matchingPrompt: z.string(), activeRules: z.array(ruleSchema), ruleSelections: modelProfileSchema.shape.options, groups: modelProfileSchema.shape.groups })
const sampleFileSchema = z.object({ referenceId: z.string(), imageVersionId: z.string(), importIntent: z.object({ role: z.enum(['positive', 'negative', 'undecided']) }), measured: z.array(z.json()), inferred: z.array(z.object({ field: z.string(), value: z.json(), uncertain: z.boolean() })) })
const referencesFileSchema = z.object({ resources: z.array(z.object({ digestKind: z.string().optional(), pixelDigest: z.string().nullable().optional() })), references: z.array(z.object({ judgments: z.array(z.object({ value: z.string() })) })) })

interface ParsedPackage {
  summary: string; matchingPrompt: string; rules: DatasetDetail['rules']; groups: DatasetDetail['groups']; files: DatasetDetail['files']; resources: DatasetDetail['resources']
  samples: z.infer<typeof sampleFileSchema>[]; identity: string
}
const packageByteLength = (artifact: ProfileExport) => Buffer.byteLength(JSON.stringify({ formatVersion: 2, export: artifact.id, files: artifact.files, resources: [] }))
function parsePackage(artifact: ProfileExport, previewChars: number): ParsedPackage {
  if (artifact.files.some(file => fileChecksum(file.content) !== file.checksum)) throw new CuratorError('reference-unavailable', 'dataset-read', 'The saved dataset failed its file checksum verification.')
  const file = (name: string) => { const value = artifact.files.find(item => item.name === name); if (!value) throw new CuratorError('reference-unavailable', 'dataset-read', 'A saved dataset file is unavailable.'); return value.content }
  const profile = profileFileSchema.parse(JSON.parse(file('style-profile.json'))), samples = file('samples.jsonl').trim().split('\n').filter(Boolean).map(line => sampleFileSchema.parse(JSON.parse(line))), references = referencesFileSchema.parse(JSON.parse(file('references.json')))
  return { summary: profile.modelSummary.summary, matchingPrompt: profile.matchingPrompt, samples,
    identity: contentDigest(artifact.files.map(({ name, checksum }) => ({ name, checksum }))),
    rules: profile.ruleSelections.map(option => ({ id: option.rule.ruleId, dimension: option.rule.dimension, statement: option.rule.statement, enabled: option.enabled, groupId: option.groupId, strength: option.rule.strength, confirmed: option.rule.confirmation.status === 'confirmed', source: option.selectionSource, supportCount: option.rule.supportRefs.length })),
    groups: profile.groups.map(group => ({ id: group.groupId, name: group.name, imageCount: group.imageVersionIds.length, enabledRules: profile.ruleSelections.filter(option => option.enabled && option.groupId === group.groupId).length })),
    // Copy the bounded preview without retaining its source backing store or changing sliced UTF-16 code units.
    files: artifact.files.map(file => ({ name: file.name, bytes: Buffer.byteLength(file.content), checksum: file.checksum, verified: true, preview: Buffer.from(file.content.slice(0, previewChars), 'utf16le').toString('utf16le'), truncated: file.content.length > previewChars })),
    resources: { remote: references.resources.filter(resource => resource.digestKind === 'remote-url-v1').length, total: references.resources.length, pixelDigests: references.resources.filter(resource => typeof resource.pixelDigest === 'string').length, humanAccepts: references.references.flatMap(reference => reference.judgments).filter(judgment => judgment.value === 'accept').length },
  }
}

/**
 * Retain derived package reads within one service owner; callers verify the current repository record and authorization before every lookup.
 * @param policy Current deployment TTL, entry count and logical byte ceiling; zero disables retention.
 * @param now Fixture clock or the process wall clock.
 * @returns Bounded package parsing and size reuse plus explicit disposal. Every hit checks the owning manifest's current record digest; metadata and derived JSON UTF-8 bytes count against the ceiling. Original package records are never retained.
 */
export function createDatasetReads(policy: () => { ttlMs: number; maxViews: number; maxBytes: number }, now: () => number = Date.now) {
  interface Cached { aggregateId: string; digest: string; byteLength?: number; size: number; derivedBytes: number; createdAt: number; parsed?: ParsedPackage; previewChars?: number }
  const entries = new Map<string, Cached>()
  let disposed = false
  function prune() {
    const limits = policy(), time = now()
    if (disposed || !limits.ttlMs || !limits.maxViews || !limits.maxBytes) { entries.clear(); return undefined }
    for (const [id, value] of entries) if (time < value.createdAt || time - value.createdAt >= limits.ttlMs) entries.delete(id)
    let bytes = [...entries.values()].reduce((total, value) => total + value.size, 0)
    while (entries.size > limits.maxViews || bytes > limits.maxBytes) { const id = entries.keys().next().value!; bytes -= entries.get(id)!.size; entries.delete(id) }
    return limits
  }
  function saved(artifact: ProfileExport, repository: DomainRepository): Cached {
    const limits = prune(), prior = entries.get(artifact.id)
    let manifest = prior ? repository.manifest(prior.aggregateId) : undefined
    let pointer = manifest?.records.find(record => record.kind === 'profileExport' && record.id === artifact.id)
    if (limits && !pointer) {
      manifest = repository.manifests().find(candidate => candidate.records.some(record => record.kind === 'profileExport' && record.id === artifact.id))
      pointer = manifest?.records.find(record => record.kind === 'profileExport' && record.id === artifact.id)
    }
    if (prior && pointer && prior.digest === pointer.digest && prior.aggregateId === manifest?.aggregateId) { entries.delete(artifact.id); entries.set(artifact.id, prior); return prior }
    entries.delete(artifact.id)
    if (limits && (!manifest || !pointer)) throw new CuratorError('reference-unavailable', 'dataset-read', 'The committed dataset is unavailable.')
    const value: Cached = { aggregateId: manifest?.aggregateId ?? '', digest: pointer?.digest ?? '', size: 0, derivedBytes: 0, createdAt: now() }
    value.size = metadataBytes(value)
    if (limits && value.size <= limits.maxBytes) { entries.set(artifact.id, value); prune() }
    return value
  }
  const metadataBytes = (value: Cached) => Buffer.byteLength(JSON.stringify({ aggregateId: value.aggregateId, digest: value.digest, byteLength: value.byteLength, createdAt: value.createdAt }))
  return {
    byteLength(artifact: ProfileExport, repository: DomainRepository) {
      const value = saved(artifact, repository)
      if (value.byteLength === undefined) { value.byteLength = packageByteLength(artifact); value.size = metadataBytes(value) + value.derivedBytes; prune() }
      return value.byteLength
    },
    read(artifact: ProfileExport, repository: DomainRepository, previewChars: number): ParsedPackage {
      const value = saved(artifact, repository)
      if (value.parsed && value.previewChars === previewChars) return value.parsed
      try {
        const parsed = parsePackage(artifact, previewChars)
        if (entries.get(artifact.id) === value) {
          value.parsed = parsed; value.previewChars = previewChars; value.derivedBytes = Buffer.byteLength(JSON.stringify(parsed))
          value.size = metadataBytes(value) + value.derivedBytes; prune()
        }
        return parsed
      } catch (error) { entries.delete(artifact.id); throw error }
    },
    dispose() { disposed = true; entries.clear() },
  }
}
/** Derived package data belongs to the service that owns and disposes its bounded cache. */
export type DatasetReads = ReturnType<typeof createDatasetReads>

/** @param domain Committed package owner. @param engine Run authorization. @param actor Current owner. @param args Untrusted entry/sample cursor. @param limits Existing preview and page settings. @param cache Optional service-owned parsed package reuse after current record checks. @returns Frozen detail with safe resource links and bounded previews. */
export function readDataset(domain: CuratorDomain, engine: RunEngine, actor: DomainActor, args: unknown, limits: { pageSize: number; maxExportPreviewChars: number }, cache?: DatasetReads): DatasetDetail {
  return domain.repository.readSnapshot(() => {
    const input = datasetDetailInputSchema.parse(args), saved = savedDataset(domain, engine, actor, input.id)
    const artifact = saved.artifact
    if (!artifact) return { entry: entry(domain, saved, cache), summary: '', matchingPrompt: '', rules: [], groups: [], samples: [], sampleTotal: 0, files: [], resources: { remote: 0, total: 0, pixelDigests: 0, humanAccepts: 0 } }
    const parsed = cache ? cache.read(artifact, domain.repository, limits.maxExportPreviewChars) : parsePackage(artifact, limits.maxExportPreviewChars)
    const filtered = input.sampleRole === 'all' ? parsed.samples : parsed.samples.filter(sample => sample.importIntent.role === input.sampleRole)
    const scope = JSON.stringify([actor.profileId, actor.sessionId ?? null, input.id, input.sampleRole, parsed.identity]), start = offset(input.pageToken, scope, filtered.map(sample => sample.referenceId)), window = filtered.slice(start, start + limits.pageSize)
    return { entry: entry(domain, saved, cache), summary: parsed.summary, matchingPrompt: parsed.matchingPrompt, rules: parsed.rules.map(rule => ({ ...rule })), groups: parsed.groups.map(group => ({ ...group })),
      samples: window.map(sample => {
        let previewPath: string | undefined, previewSize: { width: number; height: number } | undefined
        try { const { image } = domain.authorizedImage(sample.imageVersionId, actor); previewSize = { width: image.geometry.width, height: image.geometry.height }; previewPath = `/api/visual-curator/resource?imageVersionId=${encodeURIComponent(sample.imageVersionId)}` }
        catch (error) { if (!(error instanceof CuratorError) || !['owner-denied', 'reference-unavailable'].includes(error.code)) throw error; /* 旧包文本保留，已不可读的像素不提供展示链接。 */ }
        return { imageVersionId: sample.imageVersionId, referenceId: sample.referenceId, role: sample.importIntent.role, ...(previewPath ? { previewPath, previewSize } : {}), unavailable: !previewPath, measuredCount: sample.measured.length, observations: structuredClone(sample.inferred) }
      }), sampleTotal: filtered.length, ...(start + limits.pageSize < filtered.length ? { nextSamplePageToken: continuation(window.at(-1)!.referenceId, scope) } : {}),
      files: parsed.files.map(file => ({ ...file })), resources: { ...parsed.resources },
    }
  })
}
