/** Observation audit versions come from the original committed model requests. */
import { z } from 'zod'
import type { Observation, RecordOf } from '../shared/model.ts'
import type { StyleAnalysis } from '../shared/style-analysis.ts'

const bundleSchema = z.object({ bundle: z.object({ requestId: z.string(), operation: z.literal('analyze'), promptVersion: z.string().optional() }) })
const supportedVersions = z.enum(['visual-curator-v1', 'visual-curator-reference-v2', 'visual-curator-reference-v3', 'visual-curator-reference-v4'])

/** @param observations Saved original or reused evidence. @param requests Authorized repository request records. @returns The single actual version, mixed known versions, or unknown when any source receipt is missing or unsupported. */
export function observationPromptVersion(observations: readonly Observation[], requests: readonly RecordOf<'request'>[]): StyleAnalysis['observationPromptVersion'] {
  const requestIds = new Set(observations.flatMap(observation => observation.inferred.map(field => field.requestId)))
  if (!requestIds.size || observations.some(observation => !observation.inferred.length)) return 'unknown'
  const found = new Map<string, Set<StyleAnalysis['observationPromptVersion']>>()
  for (const request of requests) {
    if (request.state !== 'committed') continue
    const saved = bundleSchema.safeParse(request.data)
    if (!saved.success || !requestIds.has(saved.data.bundle.requestId)) continue
    const parsed = supportedVersions.safeParse(saved.data.bundle.promptVersion)
    const versions = found.get(saved.data.bundle.requestId) ?? new Set<StyleAnalysis['observationPromptVersion']>()
    versions.add(parsed.success ? parsed.data : 'unknown')
    found.set(saved.data.bundle.requestId, versions)
  }
  if ([...found.values()].some(versions => versions.size > 1)) return 'unknown'
  const versions = new Set([...requestIds].flatMap(id => [...found.get(id) ?? ['unknown' as const]]))
  if (versions.has('unknown')) return 'unknown'
  return versions.size === 1 ? versions.values().next().value! : 'mixed'
}
