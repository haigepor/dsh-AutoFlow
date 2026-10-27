/** Fixed current-rule instructions and deterministic style coverage for new model-profile tasks. */
import { recipeSchema, type Json, type ModelProfile, type StyleStandard, type Rule } from '../shared/model.ts'

import type { StyleMatch } from '../shared/style-matching.ts'

/** @param profile Frozen current choices. @returns Instructions with no historical matching prompt. */
export function compileStyleInstructions(profile: ModelProfile): string {
  const enabled = new Set(profile.rules.map(rule => rule.ruleId))
  const options = profile.options.filter(option => option.enabled && enabled.has(option.rule.ruleId))
  return JSON.stringify({ instruction: 'Apply the current enabled rules below. Shared rules apply to every group. Groups are alternatives; do not require unrelated groups simultaneously. Report unknown when evidence is missing. Recheck visual preferences on actual final pixels. Historical summaries do not override these rules.',
    rules: profile.rules, ruleGroups: options.map(option => ({ ruleId: option.rule.ruleId, groupId: option.groupId })), groups: profile.groups.filter(group => options.some(option => option.groupId === group.groupId)).map(group => ({ groupId: group.groupId })) })
}

/** @param standard Saved immutable standard. @param recipe Optional task-owned execution recipe. @returns Detached execution view; the standard record is never rewritten. */
export function executionStandard(standard: StyleStandard, recipe?: Json): StyleStandard {
  return recipe === undefined ? standard : { ...standard, recipe: recipeSchema.parse(recipe) }
}

/** @param profile Fixed standard. @param results Actual final rule results. @param threshold Fixed positive acceptance ratio. @returns Shared and alternative-group matching with unknown preserved. */
export function matchStyle(profile: ModelProfile, results: readonly { ruleId: string; result: string }[], threshold: number): StyleMatch {
  const rules = profile.rules.filter(rule => rule.strength === 'preferred' && rule.check.kind === 'visual')
  const memberships = new Map(profile.options.filter(option => option.enabled).map(option => [option.rule.ruleId, option.groupId]))
  const evaluate = (items: Rule[]): { verdict: StyleMatch['verdict']; ratio: number | null } => {
    if (!items.length) return { verdict: 'matched', ratio: null }
    let total = 0, satisfied = 0, unknown = false
    for (const rule of items) {
      const weight = (profile.recipe.preferenceScale.weights[rule.dimension] ?? 0) / items.filter(item => item.dimension === rule.dimension).length
      const result = results.find(item => item.ruleId === rule.ruleId)?.result
      total += weight
      if (result === 'satisfied') satisfied += weight
      else if (result !== 'violated') unknown = true
    }
    if (total === 0) return { verdict: 'unknown', ratio: null }
    const ratio = Math.min(1, satisfied / total)
    return { verdict: unknown ? 'unknown' : ratio + Number.EPSILON >= threshold ? 'matched' : 'not-matched', ratio }
  }
  const shared = evaluate(rules.filter(rule => !memberships.get(rule.ruleId)))
  const groups = [...new Set(rules.flatMap(rule => memberships.get(rule.ruleId) ? [memberships.get(rule.ruleId)!] : []))]
  const alternatives = groups.map(groupId => ({ groupId, ...evaluate(rules.filter(rule => memberships.get(rule.ruleId) === groupId)) }))
  const best = alternatives.find(group => group.verdict === 'matched') ?? alternatives.find(group => group.verdict === 'unknown') ?? alternatives[0]
  const verdict = shared.verdict !== 'matched' ? shared.verdict : best?.verdict ?? (rules.length || profile.rules.some(rule => rule.strength === 'required') ? 'matched' : 'unknown')
  return { policyVersion: 'rule-coverage-v2', verdict, groupId: shared.verdict === 'matched' ? best?.groupId ?? null : null, satisfiedWeightRatio: shared.ratio === null ? best?.ratio ?? null : best?.ratio === null || best === undefined ? shared.ratio : Math.min(shared.ratio, best.ratio), reasonCodes: verdict === 'matched' ? [] : [verdict === 'unknown' ? 'style-evidence-unknown' : 'style-preferences-unsatisfied'] }
}
