/** Frozen rule coverage owns V2 wallpaper style acceptance independently of the other visual checks. */
import type { StyleStandard, Json } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { wallpaperReviewSchema, wallpaperReviewV2Schema, wallpaperStoredReviewV2Schema, type WallpaperReview } from '../shared/wallpaper.ts'
import { matchStyle } from './style-execution.ts'
import { toJson } from './runtime.ts'

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

/** @param output Validated versioned model output. @param standard Frozen rules and recipe. @param version Frozen review protocol. @returns Effective review retaining the raw model style opinion and deterministic style result. */
export function applyWallpaperStyleReview(output: unknown, standard: StyleStandard, version: string): WallpaperReview {
  if (version !== 'wallpaper-review-v2') return wallpaperReviewSchema.parse(output)
  const review = wallpaperReviewV2Schema.parse(output)
  if (standard.kind !== 'modelProfile' || !standard.recipe.styleMatching) throw new CuratorError('constraint-conflict', 'wallpaper-review-policy', 'The current wallpaper review requires a fixed weighted model profile.')
  const styleMatch = matchStyle(standard, review.styleResults, standard.recipe.styleMatching.minSatisfiedRatio)
  const result = styleMatch.verdict === 'matched' ? 'satisfied' : styleMatch.verdict === 'unknown' ? 'unknown' : 'violated'
  const reason = result === 'satisfied' ? '按已冻结的硬性要求、软偏好权重与替代分支计算，风格覆盖达到门槛；单项软偏好不单独否决' : result === 'unknown' ? '已冻结风格规则的适用性或实际像素证据不足，需要人工复核' : '实际成品未达到已冻结的风格规则覆盖要求，需要人工复核原素材或适用规则'
  return wallpaperStoredReviewV2Schema.parse({ ...review, checks: { ...review.checks, style: { result, reason } }, modelStyleCheck: review.checks.style, styleMatch, issues: styleMatch.verdict === 'matched' ? review.issues.filter(issue => issue.kind !== 'style') : review.issues })
}
