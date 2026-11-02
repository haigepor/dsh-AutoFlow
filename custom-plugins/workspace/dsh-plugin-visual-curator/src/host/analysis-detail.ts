/** Incremental analysis observations remain tied to the current owner, frozen references and verified prefix. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import type { DomainActor } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { analysisObservationCursorSchema, type AnalysisDetail, type AnalysisObservationCursor } from '../shared/analysis-process.ts'
import { styleAnalysisOf } from '../shared/style-analysis.ts'
import { dataOf, specOf, type RunEngine } from './runtime.ts'
import { analysisRequests } from './analysis-input.ts'
import { projectAnalysisTask } from './analysis-task-reads.ts'

const readSchema = z.object({ runId: z.string().min(1), observationCursor: analysisObservationCursorSchema.optional() })
const cursorSchema = z.strictObject({ version: z.literal(1), scope: z.string(), count: z.number().int().nonnegative(), prefix: z.string() })
function decode(token: AnalysisObservationCursor | undefined) {
  if (!token) return undefined
  try { return cursorSchema.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))) }
  catch (cause) { throw new CuratorError('invalid-input', 'analysis-detail', 'Refresh this analysis before continuing.', { cause }) }
}

/** @param domain Current verified records and image permissions. @param engine Task and live process owner. @param actor Authenticated reader. @param args Run identity and optional prior observation cursor. @returns Full metadata plus a replacement or appended observation suffix; requests always contain current saved usage and state. */
export function readAnalysisDetail(domain: CuratorDomain, engine: RunEngine, actor: DomainActor, args: unknown): AnalysisDetail {
  return domain.repository.readSnapshot(() => {
    const input = readSchema.parse(args), prior = decode(input.observationCursor), run = engine.get(input.runId, actor), spec = specOf(run), data = dataOf(run)
    if (spec.kind !== 'analyze') throw new CuratorError('invalid-input', 'analysis-detail', 'Choose an analysis task.')
    const task = projectAnalysisTask(domain, engine, run, { spec, data })!
    const references = z.array(z.object({ imageVersionId: z.string() })).parse(spec.fixed.references)
    const scope = contentDigest([actor.profileId, actor.kind, actor.id, actor.sessionId ?? null, run.id, contentDigest(spec.fixed.references)])
    const authorized = new Map<string, ReturnType<CuratorDomain['authorizedImage']>>()
    const imageOf = (imageVersionId: string) => { if (!authorized.has(imageVersionId)) authorized.set(imageVersionId, domain.authorizedImage(imageVersionId, actor)); return authorized.get(imageVersionId)! }
    // Known rows still verify their backing records and current media authority; their large inferred values are not copied again.
    const headers = data.resultIds.map(id => {
      const header = domain.repository.project('observation', id, (record, digest) => ({ imageVersionId: record.imageVersionId, digest }))
      if (header) imageOf(header.imageVersionId)
      return { id, digest: header?.digest ?? null }
    })
    const prefix = (count: number) => contentDigest(headers.slice(0, count))
    const append = !!prior && prior.scope === scope && prior.count <= headers.length && prior.prefix === prefix(prior.count)
    const start = append ? prior!.count : 0
    const observations = data.resultIds.slice(start).flatMap(id => {
      const row = domain.repository.project('observation', id, record => ({ imageVersionId: record.imageVersionId, dimensions: record.inferred.map(field => ({ field: field.field, value: field.value, uncertain: field.uncertain })) }))
      return row ? [row] : []
    })
    const images = [...new Set(references.map(reference => reference.imageVersionId))].flatMap(imageVersionId => {
      const { asset } = imageOf(imageVersionId)
      return append ? [] : [{ imageVersionId, name: asset.source.description || imageVersionId }]
    })
    const observationCursor = brandString<AnalysisObservationCursor>(Buffer.from(JSON.stringify({ version: 1, scope, count: headers.length, prefix: prefix(headers.length) }), 'utf8').toString('base64url'))
    const process = engine.process(run, data), summary = styleAnalysisOf(run)?.summary
    return { task, ...(process ? { process: structuredClone(process) } : {}), requests: analysisRequests(domain, run, data.requestIds), observations, images,
      ...(summary ? { summary } : {}), observationCursor, ...(append ? { observationBase: input.observationCursor! } : {}) }
  })
}
