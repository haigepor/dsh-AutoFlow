/** Versioned subject evidence is checked separately from weighted aesthetic preferences. */
import type { Rule, StyleCandidate, StyleStandard } from '../shared/model.ts'
import type { VisionReview } from '../media/vision.ts'

type Results = readonly { ruleId: string; result: string }[]

/** @param ruleIds Explicit focal-subject requirements. @param results Their current pixel judgments. @returns Coverage without averaging a weak subject against other dimensions. */
export function focusRuleVerdict(ruleIds: readonly string[], results: Results): 'matched' | 'not-matched' | 'unknown' {
  const states = ruleIds.map(id => results.find(result => result.ruleId === id)?.result)
  return states.includes('violated') ? 'not-matched' : states.some(state => state !== 'satisfied') ? 'unknown' : 'matched'
}

/** @param rules Exact reviewed rules. @param output Validated v3 response. @returns Consistent rule results and focal requirements; reference-only hints keep their original strength. */
export function subjectReviewResults(rules: readonly Rule[], output: VisionReview): { ruleResults: VisionReview['ruleResults']; focusRuleIds: string[] } {
  const focus = (output.subjectFocus ?? []).filter(item => rules.some(rule => rule.ruleId === item.ruleId && rule.strength !== 'reference-only'))
  return {
    focusRuleIds: focus.filter(item => item.requirement !== 'presence-or-exclusion').map(item => item.ruleId),
    ruleResults: output.ruleResults.map(result => {
      const evidence = focus.find(item => item.ruleId === result.ruleId)
      if (!evidence || evidence.requirement === 'presence-or-exclusion') return result
      const status = evidence.requirement === 'unknown' || evidence.observed === 'unknown' ? 'unknown' : evidence.observed === 'dominant' ? result.status : 'violated'
      return status === result.status ? result : { ...result, status, reason: evidence.reason }
    }),
  }
}

/** @param standard Frozen shared rules and enabled alternatives. @param results Reviewed rules for this stage. @param focusRuleIds Explicit focal requirements in this request. @returns Shared focus acceptance and at least one possible alternative; unrelated groups do not veto each other. */
export function subjectFocusVerdict(standard: StyleStandard | StyleCandidate, results: Results, focusRuleIds: readonly string[]): 'matched' | 'not-matched' | 'unknown' {
  if (standard.kind !== 'modelProfile') return focusRuleVerdict(focusRuleIds, results)
  const memberships = new Map(standard.options.filter(option => option.enabled && standard.rules.some(rule => rule.ruleId === option.rule.ruleId)).map(option => [option.rule.ruleId, option.groupId]))
  const shared = focusRuleVerdict(focusRuleIds.filter(id => !memberships.get(id)), results)
  if (shared !== 'matched') return shared
  const groups = [...new Set([...memberships.values()].filter((id): id is string => id !== null))]
  const states = groups.map(group => focusRuleVerdict(focusRuleIds.filter(id => memberships.get(id) === group), results))
  return states.length === 0 || states.includes('matched') ? 'matched' : states.includes('unknown') ? 'unknown' : 'not-matched'
}
