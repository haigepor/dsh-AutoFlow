/** Frozen style coverage and original/output subject evidence independently constrain wallpaper acceptance. */
import { z } from 'zod'
import type { StyleStandard, Json } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { wallpaperSubjectIntegritySchema, wallpaperReviewKeys, wallpaperReviewSchema, wallpaperReviewV2Schema, wallpaperReviewV3Schema, wallpaperReviewV4Schema, wallpaperSourceReviewSchema, wallpaperStoredReviewV4Schema, wallpaperStoredReviewV2Schema, wallpaperStoredReviewV3Schema, wallpaperSubjectCheck, type WallpaperReview } from '../shared/wallpaper.ts'
import { matchStyle } from './style-execution.ts'
import { toJson } from './runtime.ts'

/** Extract decisive negative evidence without accepting malformed style or other visual conclusions.
 * @param output Rejected model JSON retained by the durable request diagnostic.
 * @param sourceId Authorized original identity from this task.
 * @param finalId Actual clean output identity from this task.
 * @returns Rejection-only review when strictly validated evidence establishes a cut-off subject.
 */
export function wallpaperSubjectRejection(output: unknown, sourceId: string, finalId: string): WallpaperReview | undefined {
  const evidence = z.object({ reviewVersion: z.enum(['wallpaper-review-v3', 'wallpaper-review-v4']), subjectIntegrity: z.object({ mode: wallpaperSubjectIntegritySchema.shape.mode,
    source: wallpaperSubjectIntegritySchema.shape.source.extend({ imageVersionId: z.literal(sourceId) }),
    output: wallpaperSubjectIntegritySchema.shape.output.extend({ imageVersionId: z.literal(finalId) }),
  }) }).safeParse(output)
  if (!evidence.success || ![evidence.data.subjectIntegrity.source, evidence.data.subjectIntegrity.output].some(frame => frame.extent === 'cut-off')) return undefined
  const subjectIntegrity = { ...evidence.data.subjectIntegrity, task: { result: 'unknown' as const, reason: '模型响应未通过完整格式校验，未采用其中的任务符合性结论' } }
  const subject = wallpaperSubjectCheck(subjectIntegrity)
  const schema = evidence.data.reviewVersion === 'wallpaper-review-v4' ? wallpaperStoredReviewV4Schema : wallpaperStoredReviewV3Schema
  const keys = evidence.data.reviewVersion === 'wallpaper-review-v4' ? [...wallpaperReviewKeys, 'clarity'] : wallpaperReviewKeys
  return schema.parse({ ...evidence.data, subjectIntegrity, subjectRejectionOnly: true, subject: subject.reason,
    checks: Object.fromEntries(keys.map(key => [key, key === 'subject' ? { result: 'violated', reason: subject.reason } : { result: 'unknown', reason: '模型响应未通过完整格式校验，此项未用于验收通过' }])),
    issues: [{ kind: 'preservation', reason: subject.reason }, { kind: 'unknown', reason: '仅采用独立核实的主体截断否决；原始响应及格式错误保存在本任务请求记录中，其余检查未确认' }], styleResults: [] })
}

/** @param standard Task-frozen standard and execution recipe. @returns V2 only when the fixed weighted policy is available. */
export function wallpaperReviewVersion(standard: StyleStandard): 'wallpaper-review-v1' | 'wallpaper-review-v2' {
  return standard.kind === 'modelProfile' && standard.recipe.styleMatching ? 'wallpaper-review-v2' : 'wallpaper-review-v1'
}

/** @param standard Task-frozen standard. @returns Explicit model-visible soft/hard rules and alternative-group policy. */
export function wallpaperStylePolicy(standard: StyleStandard): Json {
  if (standard.kind !== 'modelProfile' || !standard.recipe.styleMatching) throw new CuratorError('constraint-conflict', 'wallpaper-review-policy', 'This saved standard has no fixed weighted style policy for the current review. Keep its original review policy or choose a compatible task.')
  return toJson({ policyVersion: 'rule-coverage-v2', modelProfileId: standard.id, recipeId: standard.recipe.id, minSatisfiedRatio: standard.recipe.styleMatching.minSatisfiedRatio, weights: standard.recipe.preferenceScale.weights,
    rules: standard.rules.filter(rule => rule.check.kind === 'visual').map(rule => ({ ruleId: rule.ruleId, strength: rule.strength, stage: rule.stage, dimension: rule.dimension, condition: rule.condition })),
    ruleGroups: standard.options.filter(option => option.enabled).map(option => ({ ruleId: option.rule.ruleId, groupId: option.groupId })), groups: standard.groups.map(group => ({ groupId: group.groupId })) })
}

/** @param output Validated versioned model output. @param standard Frozen rules and recipe. @param version Frozen review protocol. @returns Effective review retaining model evidence and enforcing frozen style and subject requirements. */
export function applyWallpaperStyleReview(output: unknown, standard: StyleStandard, version: string): WallpaperReview {
  if (version === 'wallpaper-review-v4') {
    const review = wallpaperReviewV4Schema.parse(output), { clarity, ...checks } = review.checks
    const effective = applyWallpaperStyleReview({ ...review, reviewVersion: 'wallpaper-review-v3', checks }, standard, 'wallpaper-review-v3')
    return wallpaperStoredReviewV4Schema.parse({ ...effective, reviewVersion: 'wallpaper-review-v4', checks: { ...effective.checks, clarity } })
  }
  if (version === 'wallpaper-review-v3') {
    const { reviewVersion, subjectIntegrity, ...review } = wallpaperReviewV3Schema.parse(output)
    const effective = standard.kind === 'modelProfile' && standard.recipe.styleMatching ? applyWallpaperStyleReview(review, standard, 'wallpaper-review-v2') : review
    const integrity = wallpaperSubjectCheck(subjectIntegrity), existing = effective.checks.subject
    const subject = existing.result === 'violated' || existing.result === 'unknown' && integrity.result === 'satisfied' ? existing : integrity
    const issues = integrity.result === 'satisfied' ? effective.issues : [{ kind: 'preservation' as const, reason: integrity.reason }, ...effective.issues].slice(0, 32)
    return wallpaperStoredReviewV3Schema.parse({ ...effective, reviewVersion, subjectIntegrity, checks: { ...effective.checks, subject }, issues })
  }
  if (version !== 'wallpaper-review-v2') return wallpaperReviewSchema.parse(output)
  const review = wallpaperReviewV2Schema.parse(output)
  if (standard.kind !== 'modelProfile' || !standard.recipe.styleMatching) throw new CuratorError('constraint-conflict', 'wallpaper-review-policy', 'The current wallpaper review requires a fixed weighted model profile.')
  const styleMatch = matchStyle(standard, review.styleResults, standard.recipe.styleMatching.minSatisfiedRatio)
  const result = styleMatch.verdict === 'matched' ? 'satisfied' : styleMatch.verdict === 'unknown' ? 'unknown' : 'violated'
  const reason = result === 'satisfied' ? '按已冻结的硬性要求、软偏好权重与替代分支计算，风格覆盖达到门槛；单项软偏好不单独否决' : result === 'unknown' ? '已冻结风格规则的适用性或实际像素证据不足，需要人工复核' : '实际成品未达到已冻结的风格规则覆盖要求，需要人工复核原素材或适用规则'
  return wallpaperStoredReviewV2Schema.parse({ ...review, checks: { ...review.checks, style: { result, reason } }, modelStyleCheck: review.checks.style, styleMatch, issues: styleMatch.verdict === 'matched' ? review.issues.filter(issue => issue.kind !== 'style') : review.issues })
}

/** @param output Strict direct-original review. @returns Source-grounded subject veto plus every independent quality check. */
export function applyWallpaperSourceReview(output: unknown): WallpaperReview {
  const review = wallpaperSourceReviewSchema.parse(output), integrity = wallpaperSubjectCheck(review.subjectIntegrity)
  const existing = review.checks.subject
  const subject = existing.result === 'violated' || existing.result === 'unknown' && integrity.result === 'satisfied' ? existing : integrity
  return wallpaperSourceReviewSchema.parse({ ...review, checks: { ...review.checks, subject }, issues: integrity.result === 'satisfied' ? review.issues : [{ kind: 'preservation', reason: integrity.reason }, ...review.issues].slice(0, 32) })
}
