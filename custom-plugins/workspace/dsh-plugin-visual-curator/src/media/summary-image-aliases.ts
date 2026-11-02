/** Short model-facing image identities preserve the complete canonical evidence graph. */
import { jsonSchema, type Json } from '../shared/model.ts'
import type { StyleSummary } from '../shared/style-analysis.ts'
import { invalidInput } from './errors.ts'

const imageFields = new Set(['imageVersionId', 'imageVersionIds', 'supportImageVersionIds', 'counterImageVersionIds', 'evidenceImageVersionIds'])

/** Summary v3 evidence labels are wire identifiers; canonical identities remain in the recorded dictionary. */
export const summaryImageInstructions = 'For style summaries, use the short imageAliases keys in every imageVersionId or imageVersionIds response field. The dictionary preserves their exact original identities. Keep descriptions concise; cite representative support and counterexamples for each claim while preserving minority styles and negative constraints. Group membership may include every relevant image. Do not put image identifiers in descriptive prose.'

function replaceIdentities(value: Json, aliases: ReadonlyMap<string, string>, field = ''): Json {
  if (typeof value === 'string') return imageFields.has(field) ? aliases.get(value) ?? value : value
  if (Array.isArray(value)) return value.map(item => replaceIdentities(item, aliases, field))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceIdentities(item, aliases, key)]))
  return value
}

/**
 * Encode summary identities once; descriptions and human judgments remain unchanged.
 * @param taskBrief Saved observation input, or a freeform summary instruction.
 * @param images Attached canonical image identities in wire order.
 * @param evidenceIds Complete authorized scope when dispatching, otherwise inferred for description and compaction estimates.
 * @returns Short input labels and an audit dictionary embedded in the actual model message.
 */
export function encodeSummaryImages(taskBrief: string, images: readonly string[], evidenceIds?: readonly string[]): { taskBrief: string; imageAliases: Record<string, string> } {
  let brief: Json = taskBrief
  try { brief = jsonSchema.parse(JSON.parse(taskBrief)) }
  catch (error) { /* Freeform instructions are valid summary inputs. */ }
  const object: Record<string, Json> = brief !== null && !Array.isArray(brief) && typeof brief === 'object' ? brief : { instruction: brief }
  const samples = Array.isArray(object.samples) ? object.samples.flatMap(sample => sample !== null && !Array.isArray(sample) && typeof sample === 'object' && typeof sample.imageVersionId === 'string' ? [sample.imageVersionId] : []) : []
  const ids = [...new Set(evidenceIds ?? [...samples, ...images])], canonical = new Set(ids)
  if (images.some(id => !canonical.has(id))) throw invalidInput('A summary image is absent from its authorized evidence scope.')
  const aliases = new Map<string, string>()
  let next = 1
  for (const id of ids) {
    let alias: string
    do { alias = `r${next++}` } while (canonical.has(alias))
    aliases.set(id, alias)
  }
  const transformed = replaceIdentities(object, aliases)
  return { imageAliases: Object.fromEntries(aliases), taskBrief: JSON.stringify({ ...transformed !== null && !Array.isArray(transformed) && typeof transformed === 'object' ? transformed : {},
    imageAliases: Object.fromEntries([...aliases].map(([id, alias]) => [alias, id])),
  }) }
}

/**
 * Restore validated model labels without dropping evidence or changing group membership.
 * @param summary Summary already checked against the authorized alias and canonical scope.
 * @param aliases Canonical-to-short dictionary used in the actual request.
 * @returns Canonical evidence identities for persistence and downstream review.
 */
export function restoreSummaryImages(summary: StyleSummary, aliases: Readonly<Record<string, string>>): StyleSummary {
  const canonical = new Map(Object.entries(aliases).map(([id, alias]) => [alias, id]))
  const restore = (ids: readonly string[]) => [...new Set(ids.map(id => canonical.get(id) ?? id))]
  return { ...summary,
    dimensions: summary.dimensions.map(row => ({ ...row, supportImageVersionIds: restore(row.supportImageVersionIds), counterImageVersionIds: restore(row.counterImageVersionIds) })),
    conflicts: summary.conflicts.map(row => ({ ...row, imageVersionIds: restore(row.imageVersionIds) })),
    suggestedRules: summary.suggestedRules.map(row => ({ ...row, supportImageVersionIds: restore(row.supportImageVersionIds), counterImageVersionIds: restore(row.counterImageVersionIds) })),
    ...(summary.organization ? { organization: { ...summary.organization, groups: summary.organization.groups.map(group => ({ ...group, imageVersionIds: restore(group.imageVersionIds) })) } } : {}),
  }
}
