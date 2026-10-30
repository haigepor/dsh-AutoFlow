/** Owner-scoped, frozen package projections without image-workspace reads. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CuratorDomain } from '../domain/curator.ts'
import { profileExportIdentity } from '../domain/model-profile.ts'
import { fileChecksum } from '../domain/repository.ts'
import { CuratorError } from '../shared/errors.ts'
import { modelProfileSchema, ruleSchema, type DomainActor, type ModelProfile, type ProfileExport, type RunRecord } from '../shared/model.ts'
import { datasetProgressSchema, datasetListInputSchema, datasetDetailInputSchema, type DatasetId, type DatasetPageToken, type DatasetEntry, type DatasetList, type DatasetDetail } from '../shared/datasets.ts'
import { dataOf, specOf, type RunEngine } from './runtime.ts'
import { hiddenTaskIds } from './task-history.ts'

type Saved = { key: 'run'; run: RunRecord; profile: ModelProfile; artifact?: ProfileExport } | { key: 'artifact'; profile: ModelProfile; artifact: ProfileExport }
const accessAllowed = (access: ModelProfile['access'], actor: DomainActor) => access.kind !== 'session-run' || access.sessionId === actor.sessionId
const entryId = (saved: Saved): DatasetId => brandString<DatasetId>(saved.key === 'run' ? saved.run.id : saved.artifact.id)
const stamp = (saved: Saved): string => saved.artifact?.createdAt ?? (saved.key === 'run' ? saved.run.createdAt : saved.artifact.createdAt)
const unavailable = () => new CuratorError('owner-denied', 'dataset-read', 'This dataset is unavailable to the current owner.')

function records(domain: CuratorDomain, engine: RunEngine, actor: DomainActor): Saved[] {
  domain.repository.assertProfile(actor.profileId)
  const profiles = new Map<string, ModelProfile>(domain.repository.list('modelProfile').filter(profile => accessAllowed(profile.access, actor)).map(profile => [profile.id, profile]))
  const artifacts = domain.repository.list('profileExport').filter(record => accessAllowed(record.access, actor) && profiles.has(record.modelProfileId))
  const used = new Set<string>(), hidden = hiddenTaskIds(domain.repository), rows: Saved[] = []
  for (const run of domain.repository.list('run')) {
    if (hidden.has(run.id) || run.profileId !== actor.profileId || (run.owner.kind === 'session' ? run.owner.sessionId !== actor.sessionId : actor.kind !== 'human')) continue
    const spec = specOf(run)
    if (spec.kind !== 'export' || typeof spec.input.modelProfileId !== 'string') continue
    const profile = profiles.get(spec.input.modelProfileId)
    if (!profile) continue
    engine.authorize(run, actor)
    const operationId = z.string().min(1).parse(spec.input.operationId)
    const artifact = artifacts.find(record => dataOf(run).resultIds.includes(record.id) || record.id === profileExportIdentity(operationId))
    if (artifact) used.add(artifact.id)
    rows.push({ key: 'run', run, profile, ...(artifact ? { artifact } : {}) })
  }
  for (const artifact of artifacts) if (!used.has(artifact.id)) rows.push({ key: 'artifact', artifact, profile: domain.require('modelProfile', artifact.modelProfileId) })
  return rows.sort((left, right) => stamp(right).localeCompare(stamp(left)) || entryId(right).localeCompare(entryId(left)))
}

function entry(domain: CuratorDomain, saved: Saved): DatasetEntry {
  const { profile, artifact } = saved, run = saved.key === 'run' ? saved.run : undefined
  const progress = run ? datasetProgressSchema.safeParse(dataOf(run).checkpoint.datasetExportProgress) : undefined
  const error = run ? dataOf(run).error : undefined
  return { id: entryId(saved), ...(run ? { runId: run.id } : {}), ...(artifact ? { exportId: artifact.id, downloadPath: `/api/visual-curator/resource?exportId=${encodeURIComponent(artifact.id)}`, byteLength: Buffer.byteLength(JSON.stringify({ formatVersion: 2, export: artifact.id, files: artifact.files, resources: [] })) } : {}),
    styleId: profile.styleId, name: domain.require('style', profile.styleId).name, modelProfileId: profile.id, profileRevision: profile.revision, model: profile.model, contentDigest: profile.contentDigest,
    createdAt: stamp(saved), status: artifact ? 'completed' : run!.status,
    ...(progress?.success ? { progress: progress.data } : {}), ...(error && !artifact ? { error } : {}),
    counts: { references: profile.references.length, rules: profile.rules.length, candidates: profile.options.length, groups: profile.groups.length, enabledGroups: profile.groups.filter(group => profile.options.some(option => option.enabled && option.groupId === group.groupId)).length, files: artifact?.files.length ?? 0 },
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

/** @param domain Committed records. @param engine Run authorization. @param actor Current owner. @param args Untrusted UI query. @param pageSize Configured page length. @returns A lightweight, scope-bound page. */
export function listDatasets(domain: CuratorDomain, engine: RunEngine, actor: DomainActor, args: unknown, pageSize: number): DatasetList {
  return domain.repository.readSnapshot(() => {
    const input = datasetListInputSchema.parse(args)
    domain.require('style', input.styleId)
    const all = records(domain, engine, actor).filter(saved => saved.profile.styleId === input.styleId)
    const filtered = all.filter(saved => {
      if (input.modelProfileId && saved.profile.id !== input.modelProfileId) return false
      if (input.reusableOnly && (!saved.artifact || saved.profile.access.kind !== 'profile-library' || saved.artifact.access.kind !== 'profile-library')) return false
      const status = saved.artifact ? 'completed' : saved.key === 'run' ? saved.run.status : 'completed'
      const matches = input.status === 'all' || input.status === 'completed' && status === 'completed' || input.status === 'failed' && ['failed', 'interrupted', 'cancelled'].includes(status) || input.status === 'active' && ['created', 'running', 'pausing', 'paused', 'cancelling'].includes(status)
      const query = input.query.trim().toLocaleLowerCase()
      return matches && (!query || `${domain.require('style', saved.profile.styleId).name} ${saved.profile.model} ${entryId(saved)} ${saved.artifact?.id ?? ''}`.toLocaleLowerCase().includes(query))
    })
    const scope = JSON.stringify([actor.profileId, actor.sessionId ?? null, input.styleId, input.status, input.query, ...(input.modelProfileId || input.reusableOnly ? [input.modelProfileId ?? null, input.reusableOnly] : [])]), start = offset(input.pageToken, scope, filtered.map(entryId)), window = filtered.slice(start, start + pageSize)
    return { styleId: input.styleId, total: filtered.length, allTotal: all.length, entries: window.map(saved => entry(domain, saved)), ...(start + pageSize < filtered.length ? { nextPageToken: continuation(entryId(window.at(-1)!), scope) } : {}) }
  })
}

const profileFileSchema = z.object({ modelSummary: z.object({ summary: z.string() }), matchingPrompt: z.string(), activeRules: z.array(ruleSchema), ruleSelections: modelProfileSchema.shape.options, groups: modelProfileSchema.shape.groups })
const sampleFileSchema = z.object({ referenceId: z.string(), imageVersionId: z.string(), importIntent: z.object({ role: z.enum(['positive', 'negative', 'undecided']) }), measured: z.array(z.json()), inferred: z.array(z.object({ field: z.string(), value: z.json(), uncertain: z.boolean() })) })
const referencesFileSchema = z.object({ resources: z.array(z.object({ digestKind: z.string().optional(), pixelDigest: z.string().nullable().optional() })), references: z.array(z.object({ judgments: z.array(z.object({ value: z.string() })) })) })

/** @param domain Committed package owner. @param engine Run authorization. @param actor Current owner. @param args Untrusted entry/sample cursor. @param limits Existing preview and page settings. @returns Frozen detail with safe resource links and bounded previews. */
export function readDataset(domain: CuratorDomain, engine: RunEngine, actor: DomainActor, args: unknown, limits: { pageSize: number; maxExportPreviewChars: number }): DatasetDetail {
  return domain.repository.readSnapshot(() => {
    const input = datasetDetailInputSchema.parse(args), saved = records(domain, engine, actor).find(row => entryId(row) === input.id)
    if (!saved) throw unavailable()
    const artifact = saved.artifact
    if (!artifact) return { entry: entry(domain, saved), summary: '', matchingPrompt: '', rules: [], groups: [], samples: [], sampleTotal: 0, files: [], resources: { remote: 0, total: 0, pixelDigests: 0, humanAccepts: 0 } }
    if (artifact.files.some(file => fileChecksum(file.content) !== file.checksum)) throw new CuratorError('reference-unavailable', 'dataset-read', 'The saved dataset failed its file checksum verification.')
    const file = (name: string) => { const value = artifact.files.find(item => item.name === name); if (!value) throw new CuratorError('reference-unavailable', 'dataset-read', 'A saved dataset file is unavailable.'); return value.content }
    const profile = profileFileSchema.parse(JSON.parse(file('style-profile.json'))), samples = file('samples.jsonl').trim().split('\n').filter(Boolean).map(line => sampleFileSchema.parse(JSON.parse(line))), references = referencesFileSchema.parse(JSON.parse(file('references.json')))
    const scope = JSON.stringify([actor.profileId, actor.sessionId ?? null, input.id]), start = offset(input.pageToken, scope, samples.map(sample => sample.referenceId)), window = samples.slice(start, start + limits.pageSize)
    return { entry: entry(domain, saved), summary: profile.modelSummary.summary, matchingPrompt: profile.matchingPrompt,
      rules: profile.ruleSelections.map(option => ({ id: option.rule.ruleId, dimension: option.rule.dimension, statement: option.rule.statement, enabled: option.enabled, groupId: option.groupId, strength: option.rule.strength, confirmed: option.rule.confirmation.status === 'confirmed', source: option.selectionSource, supportCount: option.rule.supportRefs.length })),
      groups: profile.groups.map(group => ({ id: group.groupId, name: group.name, imageCount: group.imageVersionIds.length, enabledRules: profile.ruleSelections.filter(option => option.enabled && option.groupId === group.groupId).length })),
      samples: window.map(sample => {
        let previewPath: string | undefined, previewSize: { width: number; height: number } | undefined
        try { const { image } = domain.authorizedImage(sample.imageVersionId, actor); previewSize = { width: image.geometry.width, height: image.geometry.height }; previewPath = `/api/visual-curator/resource?imageVersionId=${encodeURIComponent(sample.imageVersionId)}` }
        catch (error) { if (!(error instanceof CuratorError) || !['owner-denied', 'reference-unavailable'].includes(error.code)) throw error; /* 旧包文本保留，已不可读的像素不提供展示链接。 */ }
        return { imageVersionId: sample.imageVersionId, referenceId: sample.referenceId, role: sample.importIntent.role, ...(previewPath ? { previewPath, previewSize } : {}), unavailable: !previewPath, measuredCount: sample.measured.length, observations: sample.inferred }
      }), sampleTotal: samples.length, ...(start + limits.pageSize < samples.length ? { nextSamplePageToken: continuation(window.at(-1)!.referenceId, scope) } : {}),
      files: artifact.files.map(file => ({ name: file.name, bytes: Buffer.byteLength(file.content), checksum: file.checksum, verified: true, preview: file.content.slice(0, limits.maxExportPreviewChars), truncated: file.content.length > limits.maxExportPreviewChars })),
      resources: { remote: references.resources.filter(resource => resource.digestKind === 'remote-url-v1').length, total: references.resources.length, pixelDigests: references.resources.filter(resource => typeof resource.pixelDigest === 'string').length, humanAccepts: references.references.flatMap(reference => reference.judgments).filter(judgment => judgment.value === 'accept').length },
    }
  })
}
