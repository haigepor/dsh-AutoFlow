/** Frozen style coverage and original/output subject evidence independently constrain wallpaper acceptance. */
import { z } from 'zod'
import type { StyleStandard, Json } from '../shared/model.ts'
import { wallpaperGeometry } from '../shared/wallpaper-geometry.ts'
import { wallpaperActualBoundary } from './wallpaper-boundary.ts'
import { CuratorError } from '../shared/errors.ts'
import { wallpaperSubjectIntegritySchema, wallpaperReviewKeys, wallpaperReviewSchema, wallpaperReviewV2Schema, wallpaperReviewV3Schema, wallpaperReviewV4Schema, wallpaperSourceReviewSchema, wallpaperSourceReviewV2Schema, wallpaperSourceReviewV3Schema, wallpaperSourceReviewV4Schema, wallpaperStoredSourceReviewV3Schema, wallpaperStoredSourceReviewV4Schema, type WallpaperSettings, wallpaperStoredSourceReviewV2Schema, wallpaperStoredReviewV4Schema, wallpaperStoredReviewV2Schema, wallpaperStoredReviewV3Schema, wallpaperSubjectCheck, type WallpaperReview } from '../shared/wallpaper.ts'
import { matchStyle } from './style-execution.ts'
import { toJson } from './runtime.ts'
import { contentDigest } from '../domain/repository.ts'
import type { wallpaperClockContrastSchema } from '../shared/wallpaper-policy.ts'
import type { wallpaperSourceSeams } from '../media/wallpaper-render.ts'

/** Retain model findings while rejecting objectively unreadable white clock pixels.
 * @param review Independent actual-output review. @param measurement Same output's frozen pixel-contrast evidence.
 * @returns Review with the original readability opinion and measured failure retained; contrast alone never grants acceptance.
 */
export function applyWallpaperClockContrast(review: z.infer<typeof wallpaperStoredSourceReviewV4Schema>, measurement: z.infer<typeof wallpaperClockContrastSchema>): z.infer<typeof wallpaperStoredSourceReviewV4Schema> {
  const result = { ...review, clockContrast: measurement }
  if (measurement.readableFraction >= measurement.minimumReadableFraction) return result
  const reason = `White date/time contrast: ${(measurement.readableFraction * 100).toFixed(1)}% of glyph pixels reach ${measurement.minimumRatio}:1; required ${(measurement.minimumReadableFraction * 100).toFixed(1)}%. Naturally darken the clock background without changing healthy subjects or adding text.`
  return { ...result, modelReadabilityCheck: review.modelReadabilityCheck ?? review.checks.readability, checks: { ...review.checks, readability: { result: 'violated', reason } }, issues: [...review.issues.filter(issue => issue.reason !== reason), { kind: 'readability', check: 'readability', code: 'other', reason }] }
}

/** A task without a clock policy judges the actual subject bounds and image quality, not simulated system text contrast. */
export function applyWallpaperNoClockRequirement(review: z.infer<typeof wallpaperStoredSourceReviewV4Schema>): z.infer<typeof wallpaperStoredSourceReviewV4Schema> {
  const exempt = { result: 'satisfied' as const, reason: '本任务未设置时间区域或白字对比门槛；主体位置由安全区与实际像素复审判定。' }
  return wallpaperStoredSourceReviewV4Schema.parse({ ...review,
    modelReadabilityCheck: review.modelReadabilityCheck ?? review.checks.readability,
    checks: { ...review.checks, clock: exempt, readability: exempt },
    issues: review.issues.filter(issue => issue.check !== 'clock' && issue.check !== 'readability' && issue.kind !== 'readability'),
  })
}

/** A measured source-to-extension seam rejects a model pass while preserving its other findings. */
export function applyWallpaperSourceSeams(review: z.infer<typeof wallpaperStoredSourceReviewV4Schema>, seams: Awaited<ReturnType<typeof wallpaperSourceSeams>>): z.infer<typeof wallpaperStoredSourceReviewV4Schema> {
  if (!seams.length) return review
  const names = { top: '顶部', bottom: '底部', left: '左侧', right: '右侧' }
  const first = seams[0]!
  const reason = `原图与生成扩图的${names[first.edge]}交界在${first.from}–${first.to}像素段出现明显断层：跨界平均颜色差${first.across}，相邻区域最大差${first.adjacent}；保持原图不变，重新生成外侧背景与原有景深。`
  return wallpaperStoredSourceReviewV4Schema.parse({ ...review,
    checks: { ...review.checks, background: { result: 'violated', reason: review.checks.background.result === 'violated' ? `${review.checks.background.reason}；${reason}` : reason } },
    issues: [...review.issues, { kind: 'background', check: 'background', code: 'other', reason }],
  })
}

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

/** @param output Strict direct-original review. @param edgeRepairAuthorized Saved task policy and local evidence authorize frame-edge continuation; omission retains source completeness veto. @param settings Frozen bounds required for complete-canvas review. @returns Source-grounded subject checks plus every independent quality result. */
export function applyWallpaperSourceReview(output: unknown, edgeRepairAuthorized = false, settings?: WallpaperSettings): WallpaperReview {
  const balanced = wallpaperSourceReviewV4Schema.safeParse(output)
  if (balanced.success) {
    if (!settings) throw new CuratorError('constraint-conflict', 'wallpaper-review', 'Complete-canvas review requires frozen output geometry.')
    const { actualLayout, sourceCorrespondence, issues: modelIssues, reviewVersion: _version, ...source } = balanced.data
    const base = applyWallpaperSourceReview({ ...source, reviewVersion: 'wallpaper-review-source-v2', issues: modelIssues.map(({ kind, reason }) => ({ kind, reason })) }, edgeRepairAuthorized)
    const hasSubject = actualLayout.regions.some(region => region.role === 'subject')
    const boundary = wallpaperActualBoundary(actualLayout, hasSubject ? 'group' : source.subjectIntegrity.mode, settings)
    const checks = { ...base.checks }, modelProtectionCheck = balanced.data.checks.protection
    if (hasSubject && source.subjectIntegrity.output.extent === 'not-applicable') checks.subject = { result: 'unknown', reason: '实际成品标有主体范围，须独立确认其完整性，不能记为不适用' }
    const issues = [...(base.issues.length > modelIssues.length ? [{ ...base.issues[0]!, check: 'subject' as const, code: 'other' as const }] : []), ...modelIssues]
    if (sourceCorrespondence.result !== 'satisfied') {
      if (checks.subject.result !== 'violated' || sourceCorrespondence.result === 'violated') checks.subject = sourceCorrespondence
      issues.push({ kind: 'preservation', check: 'sourceCorrespondence', code: 'other', reason: sourceCorrespondence.reason })
    }
    if (boundary.hard.length) {
      const reason = boundary.hard.join('；')
      checks.protection = { result: 'violated', reason }
      issues.push({ kind: 'layout', check: 'protection', code: 'other', reason })
    }
    const protectionIssues = modelIssues.filter(issue => issue.check === 'protection')
    const minorOnly = !boundary.hard.length && boundary.warnings.length > 0 && protectionIssues.length > 0 && protectionIssues.every(issue => issue.code === 'minor-peripheral-overflow')
    if (minorOnly && checks.protection.result === 'violated') checks.protection = { result: 'satisfied', reason: '外围细节越界在冻结面积容差内；主体核心与关键部位仍满足安全区' }
    const effectiveIssues = minorOnly ? issues.filter(issue => issue.check !== 'protection' || issue.code !== 'minor-peripheral-overflow') : issues
    return wallpaperStoredSourceReviewV4Schema.parse({ ...balanced.data, ...(edgeRepairAuthorized ? { sourceRepairAuthorized: true } : {}), checks, issues: effectiveIssues.slice(0, 32), layoutChecks: boundary.hard, layoutWarnings: boundary.warnings, modelProtectionCheck, modelIssues })
  }
  const canvas = wallpaperSourceReviewV3Schema.safeParse(output)
  if (canvas.success) {
    if (!settings) throw new CuratorError('constraint-conflict', 'wallpaper-review', 'Complete-canvas review requires frozen output geometry.')
    const { actualLayout, sourceCorrespondence, ...source } = canvas.data
    const base = applyWallpaperSourceReview({ ...source, reviewVersion: 'wallpaper-review-source-v2' }, edgeRepairAuthorized)
    const geometry = wallpaperGeometry(settings, { version: 1, imageVersionId: actualLayout.imageVersionId, mode: source.subjectIntegrity.mode, subject: source.subject, evidence: sourceCorrespondence.reason, priorities: [], anchors: [], truncations: [], uncertainties: [], regions: actualLayout.regions, placement: { scale: 1, left: 0, top: 0 }, reason: 'Actual output coordinates' }, settings)
    const checks = { ...base.checks }, issues = [...base.issues]
    if (sourceCorrespondence.result !== 'satisfied') {
      if (checks.subject.result !== 'violated' || sourceCorrespondence.result === 'violated') checks.subject = sourceCorrespondence
      issues.push({ kind: 'preservation', reason: sourceCorrespondence.reason })
    }
    if (geometry.checks.length) {
      const reason = geometry.checks.join('；')
      checks.protection = { result: 'violated', reason }; issues.push({ kind: 'layout', reason })
    }
    return wallpaperStoredSourceReviewV3Schema.parse({ ...canvas.data, ...(edgeRepairAuthorized ? { sourceRepairAuthorized: true } : {}), checks, issues: issues.slice(0, 32), layoutChecks: geometry.checks })
  }
  const current = wallpaperSourceReviewV2Schema.safeParse(output)
  const review = current.success ? current.data : wallpaperSourceReviewSchema.parse(output)
  const authorized = current.success && edgeRepairAuthorized
  const integrity = wallpaperSubjectCheck(review.subjectIntegrity, authorized)
  const existing = review.checks.subject
  const subject = existing.result === 'violated' || existing.result === 'unknown' && integrity.result === 'satisfied' ? existing : integrity
  const effective = { ...review, ...(authorized ? { sourceRepairAuthorized: true } : {}), checks: { ...review.checks, subject }, issues: integrity.result === 'satisfied' ? review.issues : [{ kind: 'preservation', reason: integrity.reason }, ...review.issues].slice(0, 32) }
  return current.success ? wallpaperStoredSourceReviewV2Schema.parse(effective) : wallpaperSourceReviewSchema.parse(effective)
}

type BalancedReview = z.infer<typeof wallpaperStoredSourceReviewV4Schema>
type CriticalCheck = keyof BalancedReview['checks'] | 'sourceRepair' | 'sourceCorrespondence'

/** @param review Saved medium-effort review. @returns Unresolved critical checks worth one focused high-effort request. */
export function wallpaperCriticalReviewTargets(review: BalancedReview): CriticalCheck[] {
  if (review.layoutChecks.length || Object.values(review.checks).some(check => check.result === 'violated') || review.sourceRepair.result === 'violated' || review.sourceCorrespondence.result === 'violated') return []
  return (['subject', 'protection', 'clarity', 'sourceRepair', 'sourceCorrespondence'] as const).filter(key => (key === 'sourceRepair' || key === 'sourceCorrespondence' ? review[key] : review.checks[key]).result === 'unknown')
}

/** @param review Medium full-frame findings. @returns A localized, answerable critical question; large or unlocalized uncertainty goes to repair instead of another whole-frame request. */
export function wallpaperCriticalReviewFocus(review: BalancedReview) {
  const targets = wallpaperCriticalReviewTargets(review)
  return review.modelIssues.find(issue => targets.includes(issue.check as CriticalCheck) && issue.detail && [issue.detail.sourceRect, issue.detail.outputRect].every(rect => rect.width * rect.height <= 0.25 && rect.width < 0.85 && rect.height < 0.85))?.detail
}

/** Reuse only the same localized question; one high review exhausts inspection of unchanged source/output pixels.
 * @param input Exact pixel identities and current localized question. @param previous Reviews of the same original and output pixels.
 * @returns A matching saved answer, or permission for the first high request; another question remains unresolved for editing.
 */
export function wallpaperCriticalReviewHistory(input: { source: string; output: string; focus: NonNullable<ReturnType<typeof wallpaperCriticalReviewFocus>>; targets: CriticalCheck[] }, previous: readonly BalancedReview[]) {
  const evidenceDigest = contentDigest({ ...input, focus: { ...input.focus, question: input.focus.question.trim().replace(/\s+/g, ' ').toLowerCase() } })
  return { evidenceDigest, cached: previous.findLast(review => review.criticalDetail?.evidenceDigest === evidenceDigest), mayInspect: !previous.some(review => review.criticalDetail) }
}

/** @param original Saved medium review. @param detail Independently checked high-effort local pixels. @param settings Frozen bounds. @param requestId Logged local request. @returns Review that changes only unresolved critical findings and retains earlier failures and layout. */
export function applyWallpaperCriticalDetail(original: BalancedReview, detail: BalancedReview, settings: WallpaperSettings, requestId: string): BalancedReview {
  const targets = wallpaperCriticalReviewTargets(original)
  const result = (review: BalancedReview, key: CriticalCheck) => key === 'sourceRepair' || key === 'sourceCorrespondence' ? review[key].result : review.checks[key].result
  const resolved = [...new Set([...targets.filter(key => result(detail, key) !== 'unknown'), ...([...wallpaperReviewKeys, 'clarity', 'sourceRepair', 'sourceCorrespondence'] as const).filter(key => result(original, key) === 'satisfied' && result(detail, key) === 'violated')])]
  const checks = { ...original.checks, protection: original.modelProtectionCheck }
  for (const key of resolved) if (key !== 'sourceRepair' && key !== 'sourceCorrespondence') checks[key] = detail.checks[key]
  const sourceRepair = resolved.includes('sourceRepair') ? detail.sourceRepair : original.sourceRepair
  const sourceCorrespondence = resolved.includes('sourceCorrespondence') ? detail.sourceCorrespondence : original.sourceCorrespondence
  const mergeExtent = (old: BalancedReview['subjectIntegrity']['source'], next: BalancedReview['subjectIntegrity']['source']) => old.extent === 'unknown' || old.extent === 'occluded' || next.extent === 'cut-off' ? next : old
  const subjectIntegrity = resolved.includes('subject') ? { ...original.subjectIntegrity,
    source: mergeExtent(original.subjectIntegrity.source, detail.subjectIntegrity.source), output: mergeExtent(original.subjectIntegrity.output, detail.subjectIntegrity.output),
    task: original.subjectIntegrity.task.result === 'unknown' ? detail.subjectIntegrity.task : original.subjectIntegrity.task } : original.subjectIntegrity
  const issues = [...original.modelIssues.filter(issue => !resolved.includes(issue.check as CriticalCheck)), ...detail.modelIssues.filter(issue => resolved.includes(issue.check as CriticalCheck)), ...detail.layoutChecks.map(reason => ({ kind: 'layout' as const, check: 'protection' as const, code: 'other' as const, reason }))].slice(0, 32)
  const raw = wallpaperSourceReviewV4Schema.parse({ reviewVersion: original.reviewVersion, subject: original.subject, checks, issues, styleResults: original.styleResults, sourceRepair, subjectIntegrity, actualLayout: original.actualLayout, sourceCorrespondence })
  const merged = applyWallpaperSourceReview(raw, original.sourceRepairAuthorized === true, settings)
  return wallpaperStoredSourceReviewV4Schema.parse({ ...merged, criticalDetail: { requestId, examinedChecks: targets, resolvedChecks: resolved } })
}
