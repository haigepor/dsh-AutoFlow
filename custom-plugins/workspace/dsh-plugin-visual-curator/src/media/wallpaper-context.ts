/** Model context excludes execution controls while preserving every image-quality requirement. */
import { jsonSchema, type Json } from '../shared/model.ts'
import { wallpaperRepairInstructions } from '../shared/wallpaper-policy.ts'

/** Project wallpaper observation inputs without changing frozen geometry, roles, rules or repair permissions.
 * @param usage Canonical logged task context; omitted and non-object contexts retain their original meaning.
 * @returns Independent model context with operational settings omitted and identical shared policy referenced once.
 */
export function wallpaperModelUsage(usage: unknown): Json | undefined {
  if (usage === undefined) return undefined
  const value = jsonSchema.parse(usage)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const result = structuredClone(value)
  const settings = result.settings
  if (typeof settings === 'object' && settings !== null && !Array.isArray(settings)) {
    for (const key of ['concurrency', 'concurrencyVersion', 'maxReworks', 'maxEditsPerImage', 'recoveryLimitVersion', 'imageProvider', 'imageSourceId', 'imageModel', 'imageSize', 'imageQuality', 'learningEnabled', 'autoPromote', 'learningInterval', 'minBenchmarks', 'maxEvalVisionCalls', 'maxSkillChars', 'decision']) delete settings[key]
  }
  const composition = result.composition
  if (typeof composition === 'object' && composition !== null && !Array.isArray(composition) && composition.instruction === wallpaperRepairInstructions) {
    composition.instruction = 'Apply the frozen repair policy in the system instructions; independently verify the actual output pixels.'
  }
  return result
}
