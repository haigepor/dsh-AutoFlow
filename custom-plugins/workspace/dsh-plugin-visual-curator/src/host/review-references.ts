/** Frozen rule evidence selects bounded, reproducible reference pixels without model requests. */
import type { ModelProfile, ReferenceSnapshot, StyleStandard } from '../shared/model.ts'

type Standard = Pick<StyleStandard, 'rules' | 'references' | 'recipe'> & Partial<Pick<ModelProfile, 'options' | 'groups'>>
type Role = ReferenceSnapshot['reference']['role']
interface Candidate {
  snapshot: ReferenceSnapshot
  bytes: number
  role: Role
  support: Set<string>
  counter: Set<string>
  groups: Set<string>
}

function compareIds(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

function effectiveVisualRules(standard: Pick<Standard, 'rules' | 'options'>) {
  const options = new Map(standard.options?.map(option => [option.rule.ruleId, option]))
  return standard.rules.filter(rule => rule.check.kind === 'visual' && rule.strength !== 'reference-only' && options.get(rule.ruleId)?.enabled !== false)
}

/** Resolve the same effective reference role for selection and model-visible image metadata.
 * @param standard Frozen effective rules and optional model-profile selections; only enabled visual-rule dimensions apply.
 * @param snapshot Frozen import intent and effective human judgments.
 * @returns Positive or negative for unanimous relevant judgments, undecided for mixed or unknown judgments, or the imported role when none apply.
 */
export function effectiveReviewReferenceRole(standard: Pick<Standard, 'rules' | 'options'>, snapshot: ReferenceSnapshot): Role {
  const dimensions = new Set(effectiveVisualRules(standard).map(rule => rule.dimension))
  const judgments = snapshot.judgments?.filter(judgment => judgment.dimension === undefined || dimensions.has(judgment.dimension)) ?? []
  if (!judgments.length) return snapshot.reference.role
  if (judgments.every(judgment => judgment.value === 'accept')) return 'positive'
  if (judgments.every(judgment => judgment.value === 'reject')) return 'negative'
  return 'undecided'
}

/** Select positive anchors covering shared rules and enabled alternatives, reserving the last slot for a contrast example.
 * @param standard Frozen effective rules, references and recipe; model profiles also supply their group selections.
 * @param referenceBytes Authorized image byte lengths. Zero denotes unmeasured remote pixels; the caller retains actual-byte enforcement.
 * @returns Original snapshots in stable review order, without repeated image identities or digests. A fitting positive is first, including for a one-image budget.
 */
export function selectReviewReferences(standard: Standard, referenceBytes: (snapshot: ReferenceSnapshot) => number): ReferenceSnapshot[] {
  const options = new Map(standard.options?.map(option => [option.rule.ruleId, option]))
  const rules = effectiveVisualRules(standard)
  const ruleIds = new Set(rules.map(rule => rule.ruleId))
  const shared = new Set(rules.filter(rule => !options.get(rule.ruleId)?.groupId).map(rule => rule.ruleId))
  const required = new Set(rules.filter(rule => rule.strength === 'required').map(rule => rule.ruleId))
  const enabledGroups = new Set(rules.flatMap(rule => options.get(rule.ruleId)?.groupId ? [options.get(rule.ruleId)!.groupId!] : []))
  const inactiveEvidence = new Set(standard.options?.filter(option => !ruleIds.has(option.rule.ruleId)).flatMap(option => [...option.rule.supportRefs, ...option.rule.counterRefs]))
  const candidates: Candidate[] = []
  for (const snapshot of standard.references) {
    const id = snapshot.reference.id
    const support = new Set(rules.filter(rule => rule.supportRefs.includes(id)).map(rule => rule.ruleId))
    const counter = new Set(rules.filter(rule => rule.counterRefs.includes(id)).map(rule => rule.ruleId))
    const memberships = standard.groups?.filter(group => group.imageVersionIds.includes(snapshot.reference.imageVersionId)) ?? []
    const groups = new Set(memberships.filter(group => enabledGroups.has(group.groupId)).map(group => group.groupId))
    for (const rule of rules) if (support.has(rule.ruleId)) {
      const groupId = options.get(rule.ruleId)?.groupId
      if (groupId) groups.add(groupId)
    }
    // Disabled alternatives cannot consume fallback slots unless they also carry active evidence.
    if (!support.size && !counter.size && !groups.size && (inactiveEvidence.has(id) || memberships.length)) continue
    candidates.push({ snapshot, bytes: referenceBytes(snapshot), role: effectiveReviewReferenceRole(standard, snapshot), support, counter, groups })
  }
  const { maxImages, maxBytes } = standard.recipe.referenceStrategy
  const selected: Candidate[] = [], images = new Set<string>(), digests = new Set<string>()
  const coveredRules = new Set<string>(), coveredGroups = new Set<string>()
  let bytes = 0
  const available = (candidate: Candidate) => !images.has(candidate.snapshot.reference.imageVersionId) && !digests.has(candidate.snapshot.imageDigest) && bytes + candidate.bytes <= maxBytes
  const newlyCovered = (values: ReadonlySet<string>, covered: ReadonlySet<string>, eligible?: ReadonlySet<string>) => [...values].filter(value => !covered.has(value) && (!eligible || eligible.has(value))).length
  const positiveScore = (candidate: Candidate) => [newlyCovered(candidate.support, coveredRules, required), newlyCovered(candidate.support, coveredRules, shared), newlyCovered(candidate.groups, coveredGroups), newlyCovered(candidate.support, coveredRules), candidate.support.size]
  const best = (items: Candidate[], score: (candidate: Candidate) => number[]) => items.filter(available).sort((left, right) => {
    const a = score(left), b = score(right)
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return b[index]! - a[index]!
    return compareIds(left.snapshot.reference.id, right.snapshot.reference.id)
  })[0]
  const positives = candidates.filter(candidate => candidate.role === 'positive')
  const contrasts = candidates.filter(candidate => candidate.role === 'negative' || candidate.counter.size)
  const undecided = candidates.filter(candidate => candidate.role === 'undecided')
  while (selected.length < maxImages) {
    const hasContrast = selected.some(candidate => candidate.role === 'negative' || candidate.counter.size)
    const contrast = hasContrast ? undefined : best(contrasts, candidate => [candidate.counter.size, candidate.role === 'negative' ? 1 : 0])
    const positive = best(positives, positiveScore)
    const finalContrast = selected.length > 0 && selected.length === maxImages - 1 ? contrast : undefined
    const next = finalContrast ?? positive ?? contrast ?? best(undecided, positiveScore)
    if (!next) break
    selected.push(next); bytes += next.bytes
    images.add(next.snapshot.reference.imageVersionId); digests.add(next.snapshot.imageDigest)
    if (next.role === 'positive') {
      for (const rule of next.support) coveredRules.add(rule)
      for (const group of next.groups) coveredGroups.add(group)
    }
  }
  return selected.map(candidate => candidate.snapshot)
}
