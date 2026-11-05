/** Frozen reference judgments and executable rules share one interpretation across exports and review. */
import type { HumanFeedback, ModelProfile, Reference, ReferenceSnapshot, Rule } from './model.ts'

/** @param rule Saved rule or its Client projection. @returns Whether the rule contributes a matching check rather than reference guidance. */
export function isMatchingRule(rule: Pick<Rule, 'strength'>): boolean {
  return rule.strength !== 'reference-only'
}

/** @param standard Frozen effective rules and optional selections. @param snapshot Frozen import intent and human judgments. @returns The unanimous relevant judgment, undecided for disagreement, or the imported role when no judgment applies. */
export function effectiveReviewReferenceRole(standard: { rules: readonly Rule[]; options?: ModelProfile['options'] }, snapshot: Pick<ReferenceSnapshot, 'reference' | 'judgments'>): ReferenceSnapshot['reference']['role'] {
  const options = new Map(standard.options?.map(option => [option.rule.ruleId, option]))
  const dimensions = new Set(standard.rules.filter(rule => rule.check.kind === 'visual' && isMatchingRule(rule) && options.get(rule.ruleId)?.enabled !== false).map(rule => rule.dimension))
  const judgments = snapshot.judgments?.filter(judgment => judgment.dimension === undefined || dimensions.has(judgment.dimension)) ?? []
  if (!judgments.length) return snapshot.reference.role
  if (judgments.every(judgment => judgment.value === 'accept')) return 'positive'
  if (judgments.every(judgment => judgment.value === 'reject')) return 'negative'
  return 'undecided'
}

/** @param rules Frozen analysis rules. @param reference Imported intent. @param feedback Fixed human judgments. @returns The same effective role used by exports, without rewriting the original intent. */
export function referenceFeedbackRole(rules: readonly Rule[], reference: Reference, feedback: readonly HumanFeedback[]): Reference['role'] {
  const judgments = feedback.filter(item => reference.feedbackThreadIds.includes(item.threadId)).flatMap(item => item.judgment.kind === 'style-verdict' ? [{ feedbackId: item.id, value: item.judgment.value }] : item.judgment.kind === 'dimension-verdict' ? [{ feedbackId: item.id, dimension: item.judgment.dimension, value: item.judgment.value }] : [])
  return effectiveReviewReferenceRole({ rules }, { reference, judgments })
}
