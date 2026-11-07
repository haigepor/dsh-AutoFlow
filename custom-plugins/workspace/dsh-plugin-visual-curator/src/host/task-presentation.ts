/** Display summaries omit image bytes, credentials and model input bodies. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import type { RunRecord, RecordOf, Json } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { requestPresentationSchema, runPresentationSchema, type TaskPresentation } from '../shared/task-presentation.ts'
import { dataOf, specOf, runContinuation, runFailure, toJson } from './runtime.ts'

type Common = Pick<TaskPresentation, 'launchId' | 'brief' | 'target' | 'outputKind' | 'pollMs' | 'wallpaper' | 'modelProfileId' | 'styleId' | 'profileRevision' | 'datasetId' | 'model'>
const fields = z.record(z.string(), z.unknown())
const failureSchema = requestPresentationSchema.shape.error.unwrap()
function requestSummary(request: RecordOf<'request'>, attempt: number, maxText: number) {
  const data = fields.parse(request.data), bundle = fields.safeParse(data.bundle ?? data)
  const operation = bundle.success && typeof bundle.data.operation === 'string' ? bundle.data.operation : 'request'
  const error = failureSchema.safeParse(data.error), output = fields.safeParse(data.output)
  const summary = output.success ? Object.fromEntries(['queries', 'summary', 'verdict', 'reason', 'taskRelevance', 'technicalStatus'].flatMap(key => {
    const value = output.data[key]
    return typeof value === 'string' || Array.isArray(value) && value.every(item => typeof item === 'string') ? [[key, value]] : []
  })) : undefined
  const text = summary && Object.keys(summary).length ? JSON.stringify(summary).slice(0, maxText) : undefined
  return requestPresentationSchema.parse({ id: request.id, createdAt: request.createdAt, state: request.state, operation, attempt, ...(error.success ? { error: error.data } : {}), ...(text ? { output: text } : {}) })
}

/**
 * Summarize only committed task facts using its frozen display limits.
 * @param domain Task owner.
 * @param run Committed task revision.
 * @param common Frozen group requirements.
 * @param asOf Saved checkpoint time; replay must not change the same revision when a deadline expires.
 * @returns Bounded JSON for the native task journal.
 */
export function presentRun(domain: CuratorDomain, run: RunRecord, common: Common, asOf: string): Json {
  const spec = specOf(run), data = dataOf(run)
  const requests = data.requestIds.map(id => {
    const request = domain.require('request', id)
    if (request.runId !== run.id) throw new CuratorError('reference-unavailable', 'task-presentation', 'A saved request belongs to another task.')
    return request
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const attempts = new Map<string, number>()
  const rows = requests.map(request => {
    const attempt = (attempts.get(request.requestDigest) ?? 0) + 1; attempts.set(request.requestDigest, attempt)
    return requestSummary(request, attempt, Math.max(1, Math.floor(spec.config.limits.maxProcessTextChars / spec.config.limits.pageSize)))
  })
  const error = runFailure(run)
  return toJson(runPresentationSchema.parse({
    type: 'run', ...common, model: { provider: spec.config.vision.provider, model: spec.config.vision.model },
    runId: run.id, runKind: spec.input.workflow === 'wallpaper-v1' ? 'wallpaper' : spec.kind,
    status: run.status, stage: run.stage, ...(run.outcome ? { outcome: run.outcome } : {}), counts: data.counts,
    requestCount: requests.length, requests: rows.slice(-spec.config.limits.pageSize), failures: rows.filter(row => row.error).slice(-spec.config.limits.pageSize),
    ...(error ? { error } : {}), warnings: data.warnings, continuation: runContinuation(run, requests, Date.parse(asOf)).allowed,
  }))
}
