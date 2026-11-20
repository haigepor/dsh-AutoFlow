/** Frozen style coverage and original/output subject evidence independently constrain wallpaper acceptance. */
import { z } from 'zod'
import type { StyleStandard, Json, PixelRect } from '../shared/model.ts'
import { wallpaperGeometry, wallpaperPracticalRegionBoundary, wallpaperProtectedBounds, type WallpaperSourceLayout } from '../shared/wallpaper-geometry.ts'
import { wallpaperActualBoundary } from './wallpaper-boundary.ts'
import { CuratorError } from '../shared/errors.ts'
import { wallpaperSubjectIntegritySchema, wallpaperReviewKeys, wallpaperReviewSchema, wallpaperReviewV2Schema, wallpaperReviewV3Schema, wallpaperReviewV4Schema, wallpaperSourceReviewSchema, wallpaperSourceReviewV2Schema, wallpaperSourceReviewV3Schema, wallpaperSourceReviewV4Schema, wallpaperStoredSourceReviewV3Schema, wallpaperStoredSourceReviewV4Schema, type WallpaperPlan, type WallpaperSettings, wallpaperStoredSourceReviewV2Schema, wallpaperStoredReviewV4Schema, wallpaperStoredReviewV2Schema, wallpaperStoredReviewV3Schema, wallpaperSubjectCheck, type WallpaperReview } from '../shared/wallpaper.ts'
import { matchStyle } from './style-execution.ts'
import { toJson } from './runtime.ts'
import { contentDigest } from '../domain/repository.ts'
import type { wallpaperClockContrastSchema } from '../shared/wallpaper-policy.ts'
import type { wallpaperSourceSeams } from '../media/wallpaper-render.ts'
import { MediaError } from '../media/errors.ts'
import type { VisionInput } from '../media/vision.ts'
import { wallpaperBoundaryReviewNeeded, wallpaperExpansionReview, wallpaperPracticalAcceptance } from '../shared/wallpaper-policy.ts'
import { wallpaperPracticalReviewSchema, type WallpaperPracticalReview } from '../shared/wallpaper-practical.ts'

export { wallpaperBoundaryReviewNeeded } from '../shared/wallpaper-policy.ts'

function practicalReviewFields(review: WallpaperPracticalReview): z.infer<typeof wallpaperSourceReviewV4Schema> {
  const accepted = { result: 'satisfied' as const, reason: '按原图有意取景范围检查，未见影响使用的明显缺陷；不要求补入画外身体或背面。' }
  const checks: z.infer<typeof wallpaperSourceReviewV4Schema>['checks'] = { subject: accepted, protection: accepted, clock: accepted, readability: accepted, composition: accepted, background: accepted, style: accepted, clarity: accepted }
  const issues: z.infer<typeof wallpaperSourceReviewV4Schema>['issues'] = []
  for (const defect of review.defects.filter(value => value.severity === 'major' && value.kind !== 'layout')) {
    const check = defect.kind === 'subject-damage' ? 'subject' : defect.kind === 'quality-loss' ? 'clarity' : defect.kind === 'style-change' ? 'style' : 'background'
    checks[check] = { result: 'violated', reason: defect.reason }
    issues.push({ kind: check === 'background' ? 'background' : check === 'style' ? 'style' : 'preservation', check, code: defect.kind === 'collage-seam' ? 'collage-seam' : 'other', reason: defect.reason,
      ...(defect.outputRect ? { evidence: { kind: check === 'background' ? 'background-artifact' : check === 'style' ? 'style-change' : check === 'clarity' ? 'detail-loss' : 'distorted-structure', entityIds: [], imageVersionId: review.outputImageVersionId, outputRect: defect.outputRect } } : {}) })
  }
  const missingFoliage = review.actualLayout.regions.flatMap(region => 'attachedFoliage' in region && region.attachedFoliage?.status === 'unknown' ? [`${region.name} · ${region.attachedFoliage.reason}`] : [])
  const uncertainties = [...missingFoliage, ...review.uncertainties]
  const uncertain = uncertainties.length > 0 || review.mode === 'uncertain'
  const uncertainty = { result: 'unknown' as const, reason: uncertainties.join('；') || '实际主体范围尚无法确认，需要人工复核。' }
  if (uncertain && checks.subject.result === 'satisfied') checks.subject = uncertainty
  if (uncertain) issues.push({ kind: 'unknown', check: 'subject', code: 'other', reason: uncertainty.reason, ...(review.inspection ? { detail: review.inspection } : {}) })
  const usableExtent = !review.actualLayout.regions.some(region => region.role === 'subject') && (review.mode === 'scene' || review.mode === 'abstract') ? 'not-applicable' as const : 'complete' as const
  let sourceCorrespondence: z.infer<typeof wallpaperSourceReviewV4Schema>['sourceCorrespondence'] = accepted
  if (review.protocol === 'practical-v2') {
    const results = review.sourcePreservation.flatMap(row => (['framing', 'appearance', 'relationships'] as const).map(key => ({ entityId: row.entityId, key, ...row[key] })))
    for (const check of results.filter(check => check.result !== 'satisfied')) {
      const target = check.key === 'appearance' ? 'subject' : 'composition'
      if (checks[target].result !== 'violated') checks[target] = { result: check.result, reason: check.reason }
      issues.push({ kind: check.result === 'unknown' ? 'unknown' : 'preservation', check: 'sourceCorrespondence', code: 'other', reason: `${check.entityId} · ${check.key}: ${check.reason}` })
    }
    if (review.sourceStyle.result !== 'satisfied') {
      if (checks.style.result !== 'violated') checks.style = review.sourceStyle
      issues.push({ kind: review.sourceStyle.result === 'unknown' ? 'unknown' : 'style', check: 'sourceCorrespondence', code: 'other', reason: review.sourceStyle.reason })
    }
    const explicit = [...results, review.sourceStyle]
    const firstFailure = explicit.find(check => check.result === 'violated') ?? explicit.find(check => check.result === 'unknown')
    sourceCorrespondence = firstFailure ? { result: firstFailure.result, reason: firstFailure.reason } : { result: 'satisfied', reason: '原图取景、可见外观、实体关系及媒介风格均已逐项对照实际成品确认。' }
  }
  return { reviewVersion: review.reviewVersion, subject: review.subject, checks, issues: issues.slice(0, 32), styleResults: [], sourceRepair: accepted, sourceCorrespondence,
    subjectIntegrity: { mode: review.mode, source: { extent: usableExtent, reason: accepted.reason, imageVersionId: review.sourceImageVersionId }, output: { extent: uncertain ? 'unknown' : usableExtent, reason: uncertain ? uncertainty.reason : checks.subject.reason, imageVersionId: review.outputImageVersionId }, task: checks.subject },
    actualLayout: { imageVersionId: review.outputImageVersionId, regions: review.actualLayout.regions.map(region => {
      if (!('extrema' in region) || !region.extrema) return region
      const { extrema, attachedFoliage, ...body } = region
      const component = attachedFoliage?.status === 'located' ? attachedFoliage.rect : body.rect
      const x = Math.min(extrema.left.coordinate, body.rect.x, component.x), y = Math.min(extrema.top.coordinate, body.rect.y, component.y)
      return { ...body, rect: { x, y, width: Math.max(extrema.right.coordinate, body.rect.x + body.rect.width, component.x + component.width) - x, height: Math.max(extrema.bottom.coordinate, body.rect.y + body.rect.height, component.y + component.height) - y } }
    }) } }
}

/** Reject explicit extra instances before interpreting the model's overall opinion.
 * @param review Actual full-canvas model observation with optional inventory for newer tasks.
 * @returns The observation with inventory-backed background failures; original raw output remains in its request record.
 */
export function applyWallpaperInventory(review: z.infer<typeof wallpaperSourceReviewV4Schema>): z.infer<typeof wallpaperSourceReviewV4Schema> {
  if (!review.inventory) return review
  const findings = [...review.inventory.flatMap(row => row.instances.slice(row.sourceInstances?.length ?? row.instances.length).map(rect => ({ reason: `额外物体 ${row.entityId}：${row.reason}`, rect }))), ...(review.newForeground ?? []).map(row => ({ reason: `新增前景 ${row.name}：${row.reason}`, rect: row.rect }))]
  const changed = review.inventory.filter(row => row.status !== 'retained' || !row.instances.length)
  if (!findings.length && !changed.length) return review
  const subject = changed.length ? { result: changed.some(row => row.status === 'missing' || row.status === 'changed' || !row.instances.length && row.status !== 'uncertain') ? 'violated' as const : 'unknown' as const, reason: changed.map(row => `${row.entityId} (${row.status})：${row.reason}`).join('；') } : review.checks.subject
  const background = findings.length ? { result: 'violated' as const, reason: findings.map(finding => finding.reason).join('；') } : review.checks.background
  const correspondence = changed.length ? subject : review.sourceCorrespondence
  return { ...review, sourceCorrespondence: correspondence, checks: { ...review.checks, subject, background }, issues: [...review.issues,
    ...changed.map(row => ({ kind: 'preservation' as const, check: 'subject' as const, code: 'other' as const, reason: `${row.entityId} (${row.status})：${row.reason}` })),
    ...findings.map(finding => ({ kind: 'background' as const, check: 'background' as const, code: 'other' as const, reason: finding.reason, evidence: { kind: 'background-artifact' as const, entityIds: [], imageVersionId: review.actualLayout.imageVersionId, outputRect: finding.rect } })),
  ].slice(0, 32) }
}

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
export function applyWallpaperSourceSeams(review: z.infer<typeof wallpaperStoredSourceReviewV4Schema>, seams: Awaited<ReturnType<typeof wallpaperSourceSeams>>, mode: 'source-restored' | 'candidate-restored' | 'generated-canvas' = 'source-restored'): z.infer<typeof wallpaperStoredSourceReviewV4Schema> {
  if (!seams.length) return review
  const names = { top: '顶部', bottom: '底部', left: '左侧', right: '右侧' }
  const first = seams[0]!
  const reason = mode === 'generated-canvas'
    ? `生成图在原图${names[first.edge]}截断位置的${first.from}–${first.to}像素段仍有平直断层：跨界平均颜色差${first.across}，相邻区域最大差${first.adjacent}；保持整组位置，沿可见轮廓短距离自然收口并接续背景。`
    : `${mode === 'candidate-restored' ? '已定位候选' : '原图'}与生成扩图的${names[first.edge]}交界在${first.from}–${first.to}像素段出现明显断层：跨界平均颜色差${first.across}，相邻区域最大差${first.adjacent}；保持${mode === 'candidate-restored' ? '已定位候选' : '原图'}不变，重新生成外侧背景与原有景深。`
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

/** @param output Strict direct-original review. @param edgeRepairAuthorized Saved task policy and local evidence authorize frame-edge continuation; omission retains source completeness veto. @param settings Frozen bounds required for complete-canvas review. @param sourceLayout Frozen output focus and minimum source-relative size. @param sourcePreservation Verified preservation rows from the same original/output pair when rechecking a merged detail review. @returns Source-grounded subject checks plus every independent quality result. */
export function applyWallpaperSourceReview(output: unknown, edgeRepairAuthorized = false, settings?: WallpaperSettings, sourceLayout?: WallpaperSourceLayout, sourcePreservation?: Extract<WallpaperPracticalReview, { protocol: 'practical-v2' }>['sourcePreservation']): WallpaperReview {
  const practical = wallpaperPracticalReviewSchema.safeParse(output)
  const balanced = wallpaperSourceReviewV4Schema.safeParse(practical.success ? practicalReviewFields(practical.data) : output)
  if (balanced.success) {
    balanced.data = applyWallpaperInventory(balanced.data)
    if (!settings) throw new CuratorError('constraint-conflict', 'wallpaper-review', 'Complete-canvas review requires frozen output geometry.')
    const { actualLayout: observedLayout, sourceCorrespondence, issues: modelIssues, reviewVersion: _version, inventory: _inventory, newForeground: _newForeground, ...source } = balanced.data
    const actualLayout = { ...observedLayout, regions: observedLayout.regions.map(region => {
      const evidence = modelIssues.flatMap(issue => issue.evidence?.kind === 'safe-area-overflow' && issue.code !== 'minor-peripheral-overflow' && issue.evidence.imageVersionId === observedLayout.imageVersionId && region.scope === 'core' && region.entityId && issue.evidence.entityIds.includes(region.entityId) ? [issue.evidence.outputRect] : [])
      if (wallpaperExpansionReview(settings)?.version === 'expansion-first-v2' && region.scope === 'core' && region.role === 'subject' && region.entityId
        && !sourceLayout?.expectedSubjects?.some(subject => subject.entityId === region.entityId && subject.hasAccessory)) {
        for (const part of observedLayout.regions) if (part.scope === 'peripheral' && part.entityId === region.entityId && part.role === 'subject') evidence.push(part.rect)
      }
      if (!evidence.length) return region
      const rects = [region.rect, ...evidence], x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y))
      return { ...region, rect: { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x, height: Math.max(...rects.map(rect => rect.y + rect.height)) - y } }
    }) }
    const base = applyWallpaperSourceReview({ ...source, reviewVersion: 'wallpaper-review-source-v2', issues: modelIssues.map(({ kind, reason }) => ({ kind, reason })) }, edgeRepairAuthorized, settings, sourceLayout)
    const hasSubject = actualLayout.regions.some(region => region.role === 'subject')
    const preservation = practical.success && practical.data.protocol === 'practical-v2' ? practical.data.sourcePreservation : sourcePreservation
    const preservedActionParts = new Set(preservation?.filter(row => row.framing.result === 'satisfied' && row.appearance.result === 'satisfied' && row.relationships.result === 'satisfied').map(row => row.entityId))
    const boundary = wallpaperActualBoundary(actualLayout, wallpaperPracticalAcceptance(settings) ? source.subjectIntegrity.mode : hasSubject ? 'group' : source.subjectIntegrity.mode, settings, sourceLayout, preservedActionParts)
    const checks = { ...base.checks }, modelProtectionCheck = balanced.data.checks.protection
    if (hasSubject && source.subjectIntegrity.output.extent === 'not-applicable') checks.subject = { result: 'unknown', reason: '实际成品标有主体范围，须独立确认其完整性，不能记为不适用' }
    const issues = [...(base.issues.length > modelIssues.length ? [{ ...base.issues[0]!, check: 'subject' as const, code: 'other' as const }] : []), ...modelIssues]
    if (sourceCorrespondence.result !== 'satisfied') {
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
    const effective = { ...balanced.data, actualLayout, modelChecks: balanced.data.checks, ...(edgeRepairAuthorized ? { sourceRepairAuthorized: true } : {}), checks, issues: effectiveIssues.slice(0, 32), layoutChecks: boundary.hard, layoutWarnings: boundary.warnings, modelProtectionCheck, modelIssues }
    if (!practical.success) return wallpaperStoredSourceReviewV4Schema.parse(effective)
    const warnings = practical.data.defects.filter(defect => defect.severity === 'minor' || defect.kind === 'layout').map(defect => defect.reason)
    const sourceUnknowns = practical.data.protocol === 'practical-v2' ? [...practical.data.sourcePreservation.flatMap(row => (['framing', 'appearance', 'relationships'] as const).filter(key => row[key].result === 'unknown').map(key => `${row.entityId} · ${key}: ${row[key].reason}`)), ...(practical.data.sourceStyle.result === 'unknown' ? [practical.data.sourceStyle.reason] : [])] : []
    const uncertainties = [...(practical.data.mode === 'uncertain' && !practical.data.uncertainties.length ? ['实际主体范围尚无法确认，需要人工复核。'] : practical.data.uncertainties), ...sourceUnknowns].slice(0, 4)
    return wallpaperStoredSourceReviewV4Schema.parse({ ...effective, layoutWarnings: [...effective.layoutWarnings, ...warnings], practicalReview: { version: practical.data.protocol, warnings, uncertainties, ...(practical.data.protocol === 'practical-v2' ? { sourcePreservation: practical.data.sourcePreservation, sourceStyle: practical.data.sourceStyle } : {}) } })
  }
  const canvas = wallpaperSourceReviewV3Schema.safeParse(output)
  if (canvas.success) {
    if (!settings) throw new CuratorError('constraint-conflict', 'wallpaper-review', 'Complete-canvas review requires frozen output geometry.')
    const { actualLayout, sourceCorrespondence, ...source } = canvas.data
    const base = applyWallpaperSourceReview({ ...source, reviewVersion: 'wallpaper-review-source-v2' }, edgeRepairAuthorized, settings, sourceLayout)
    const geometry = wallpaperGeometry(settings, { version: 1, imageVersionId: actualLayout.imageVersionId, mode: source.subjectIntegrity.mode, subject: source.subject, evidence: sourceCorrespondence.reason, priorities: [], anchors: [], truncations: [], uncertainties: [], regions: actualLayout.regions, placement: { scale: 1, left: 0, top: 0 }, reason: 'Actual output coordinates' }, settings, sourceLayout)
    const checks = { ...base.checks }, issues = [...base.issues]
    if (sourceCorrespondence.result !== 'satisfied') {
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
type ActualRegion = BalancedReview['actualLayout']['regions'][number]
type SafetyEdge = 'left' | 'right' | 'top' | 'bottom'

function subjectOutside(region: ActualRegion, settings: WallpaperSettings): boolean {
  const { x, y, width, height } = region.rect
  const boundary = wallpaperPracticalRegionBoundary({ ...region, left: x * settings.width, top: y * settings.height, width: width * settings.width, height: height * settings.height }, settings)
  return boundary?.hard.some(check => check.startsWith('subject-overflow:')) === true
}

/** @param final Independent review of the delivered file. @param native Review of the same verified full frame before resizing. @param settings Frozen safety policy. @param sourceLayout Frozen placement targets. @returns Final quality findings with a consistent geometry measurement for the same visible main subjects. */
export function applyWallpaperStableFrameReview(final: BalancedReview, native: BalancedReview, settings: WallpaperSettings, sourceLayout?: WallpaperSourceLayout): BalancedReview {
  if (native.checks.protection.result === 'unknown' || native.practicalReview?.uncertainties.length
    || final.modelIssues.some(issue => issue.check === 'protection' && issue.evidence?.kind === 'safe-area-overflow')) return final
  const ordinarySubject = (region: ActualRegion) => region.role === 'subject' && region.scope === 'core' && region.safetyClass !== 'automobile'
  const identity = (region: ActualRegion) => region.entityId ?? region.name
  const earlier = native.actualLayout.regions.filter(ordinarySubject)
  const actual = final.actualLayout.regions.filter(ordinarySubject)
  const matching = new Map(earlier.map(region => [identity(region), region]))
  if (!matching.size || matching.size !== earlier.length || earlier.length !== actual.length
    || new Set(actual.map(identity)).size !== matching.size || actual.some(region => !matching.has(identity(region)))) return final
  // Keep a failing observation from either stage until the saved output's local edge is measured.
  const actualLayout = { ...final.actualLayout, regions: final.actualLayout.regions.map(region =>
    ordinarySubject(region) && !subjectOutside(region, settings)
    && !sourceLayout?.expectedSubjects?.some(subject => subject.entityId === region.entityId && subject.attachedFoliage) ? matching.get(identity(region))! : region) }
  const preserved = new Set(final.practicalReview?.sourcePreservation?.filter(row => row.framing.result === 'satisfied' && row.appearance.result === 'satisfied' && row.relationships.result === 'satisfied').map(row => row.entityId))
  const { hard, warnings } = wallpaperActualBoundary(actualLayout, final.subjectIntegrity.mode, settings, sourceLayout, preserved)
  const reason = hard.join('；')
  const issues = final.issues.filter(issue => issue.kind !== 'layout' || issue.check !== 'protection' || !!issue.evidence)
  if (hard.length) issues.unshift({ kind: 'layout', check: 'protection', code: 'other', reason })
  return {
    ...final,
    actualLayout,
    checks: { ...final.checks, protection: hard.length ? { result: 'violated', reason } : final.modelProtectionCheck },
    issues: issues.slice(0, 32),
    layoutChecks: hard,
    layoutWarnings: [...new Set([...warnings, ...(final.practicalReview?.warnings ?? [])])],
  }
}
const safetyEdges: readonly SafetyEdge[] = ['left', 'right', 'top', 'bottom']
const edgePositions = ({ x, y, width, height }: ActualRegion['rect']) => ({ left: x, right: x + width, top: y, bottom: y + height })

/** One protected edge whose visible endpoint requires a saved crop of the same actual canvas. */
export interface WallpaperSafetyCropTarget {
  regionIndex: number
  entityId?: string | undefined
  name: string
  role: ActualRegion['role']
  edge: SafetyEdge
  outsideOnly?: true
  thresholdLine?: number
  contestedClearance?: true
  component?: 'attached-foliage'
  rect: ActualRegion['rect']
}

const safetyCropPoint = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
const safetyCropReference = z.strictObject({ cropImageVersionId: z.string(), edge: z.enum(safetyEdges) })
const safetyCropObservation = z.discriminatedUnion('status', [safetyCropReference.extend({ status: z.literal('clear') }), safetyCropReference.extend({ status: z.literal('unknown') }), safetyCropReference.extend({ status: z.literal('measured'), point: safetyCropPoint })])

/** A measured endpoint on its exact crop, or an explicit unresolved observation. */
export type WallpaperSafetyCropEvidence = z.infer<typeof safetyCropObservation>

function boundaryCropPadding(settings: WallpaperSettings, policy: NonNullable<ReturnType<typeof wallpaperPracticalAcceptance>>) {
  return Math.max(settings.processing?.layoutInsetPixels ?? 0,
    (policy.version === 'practical-v2' ? policy.nearBoundaryRecheck?.maximumOutputShortSideRatio ?? 0 : 0) * Math.min(settings.width, settings.height))
}

/** @param review Initial review on the actual target pixels. @param settings Frozen safety rectangle and inspection window. @param corroboratedFrame Whether delivery kept the prior native framing. @param savedMeasurements Completed observations of the same output bytes, used to locate disputed edges. @param verifyVerticalGroup Require the actual highest and lowest subject endpoints even when the overview estimates fit. @param sourceLayout Frozen source components requiring independent native measurements. @returns Crops around vulnerable parts, vehicle edges and disputed or required subject extents. */
export function wallpaperSafetyReviewRegions(review: BalancedReview, settings: WallpaperSettings, corroboratedFrame = false, savedMeasurements: readonly BalancedReview[] = [], verifyVerticalGroup = false, sourceLayout?: WallpaperSourceLayout): WallpaperSafetyCropTarget[] {
  const policy = wallpaperPracticalAcceptance(settings)
  if (policy?.version !== 'practical-v2') return []
  const { width, height } = settings, bounds = wallpaperProtectedBounds(settings)
  const padding = boundaryCropPadding(settings, policy)
  if (!padding) return []
  const lines = { left: bounds.critical.left / width, right: bounds.critical.right / width, top: bounds.top / height, bottom: bounds.critical.bottom / height }
  const earlierRegions = savedMeasurements.flatMap(saved => saved.actualLayout.regions).filter(region => region.scope === 'core')
  const subjects = verifyVerticalGroup ? review.actualLayout.regions.flatMap((region, regionIndex) => region.scope === 'core' && region.role === 'subject' ? [{ region, regionIndex }] : []) : []
  const upper = subjects.toSorted((a, b) => a.region.rect.y - b.region.rect.y)[0]
  const lower = subjects.toSorted((a, b) => b.region.rect.y + b.region.rect.height - a.region.rect.y - a.region.rect.height)[0]
  const groupPadding = Math.max(padding / height, (1 - (policy.expansionReview?.minimumPlannedScaleRatio ?? 1)) * (lines.bottom - lines.top))
  const groupTargets: WallpaperSafetyCropTarget[] = upper && lower ? ([['top', upper], ['bottom', lower]] as const).map(([edge, { region, regionIndex }]) => {
    const point = edgePositions(region.rect)[edge], x = Math.max(0, region.rect.x - padding / width), y = Math.max(0, point - groupPadding)
    return { regionIndex, entityId: region.entityId, role: region.role, name: region.name, edge,
      rect: { x, y, width: Math.min(1, region.rect.x + region.rect.width + padding / width) - x, height: Math.min(1, point + groupPadding) - y } }
  }) : []
  const foliageTargets: WallpaperSafetyCropTarget[] = review.actualLayout.regions.flatMap((region, regionIndex) =>
    region.role === 'subject' && region.scope === 'core' && sourceLayout?.expectedSubjects?.some(subject => subject.attachedFoliage && subject.entityId === region.entityId)
      ? [{ regionIndex, entityId: region.entityId, name: region.name, role: region.role, edge: 'top', component: 'attached-foliage',
        rect: { x: 0, y: 0, width: 1, height: Math.min(1, Math.max(lines.top, region.rect.y + region.rect.height) + padding / height) } }] : [])
  const safetyTargets = review.actualLayout.regions.flatMap((region, regionIndex) => {
    if (region.scope !== 'core') return []
    const strict = region.role === 'critical' || region.safetyClass === 'automobile'
    const outside = !strict && region.role === 'subject' && subjectOutside(region, settings)
    const earlier = region.entityId ? earlierRegions.filter(other => other.entityId === region.entityId && other.role === region.role) : []
    const disputed = earlier.some(other => subjectOutside(other, settings) !== outside)
    const positions = edgePositions(region.rect)
    const stackEdges = sourceLayout?.stackedSubjects ? groupTargets.filter(target => target.regionIndex === regionIndex).map(target => target.edge) : []
    if (!strict && !disputed && !(corroboratedFrame && outside) && !stackEdges.length) return []
    const observations = [positions, ...earlier.map(other => edgePositions(other.rect))]
    const envelope = { left: Math.min(...observations.map(box => box.left)), right: Math.max(...observations.map(box => box.right)),
      top: Math.min(...observations.map(box => box.top)), bottom: Math.max(...observations.map(box => box.bottom)) }
    const range = (edge: SafetyEdge) => Math.max(...observations.map(box => box[edge])) - Math.min(...observations.map(box => box[edge]))
    const padX = Math.max(padding / width, range('left'), range('right'))
    const padY = Math.max(stackEdges.length ? groupPadding : padding / height, range('top'), range('bottom'))
    const overflowing = (edge: SafetyEdge) => edge === 'left' || edge === 'top' ? envelope[edge] < lines[edge] : envelope[edge] > lines[edge]
    return safetyEdges.flatMap(edge => {
      const vertical = edge === 'left' || edge === 'right', before = edge === 'left' || edge === 'top'
      const overflow = (positions[edge] - lines[edge]) * (vertical ? width : height) * (before ? -1 : 1)
      const disputedAxis = disputed && (vertical ? overflowing('left') || overflowing('right') : overflowing('top') || overflowing('bottom'))
      const stackEdge = stackEdges.includes(edge) && overflow >= -padding
      if (!stackEdge && !disputedAxis && (strict ? overflow < -padding && !overflowing(edge) : !overflowing(edge))) return []
      const line = disputedAxis && !overflowing(edge) ? positions[edge] : lines[edge]
      const near = Math.min(line, ...observations.map(box => box[edge])), far = Math.max(line, ...observations.map(box => box[edge]))
      const x = Math.max(0, (vertical ? near : strict ? envelope.left : Math.min(lines.left, envelope.left)) - padX)
      const y = Math.max(0, (vertical ? !strict ? Math.min(lines.top, envelope.top) : envelope.top : near) - padY)
      const right = Math.min(1, (vertical ? far : strict ? envelope.right : Math.max(lines.right, envelope.right)) + padX)
      const bottom = Math.min(1, (vertical ? !strict ? Math.max(lines.bottom, envelope.bottom) : envelope.bottom : far) + padY)
      const target = { regionIndex, entityId: region.entityId, name: region.name, role: region.role, edge, rect: { x, y, width: right - x, height: bottom - y }, overflow }
      const wholeSubject = settings.sourceIntentPolicy?.alignment === 'subject-fill-v1' && settings.sourceIntentPolicy.wholeSubjectSafety === 'extrema-v1'
      if (region.safetyClass !== 'automobile' && !(wholeSubject && (outside && overflow > 0 || stackEdge))) return [target]
      let thresholdLine = lines[edge]
      if (!strict) {
        const alongStart = vertical ? positions.left : positions.top, alongEnd = vertical ? positions.right : positions.bottom
        const safeStart = vertical ? lines.left : lines.top, safeEnd = vertical ? lines.right : lines.bottom
        const crossStart = vertical ? positions.top : positions.left, crossEnd = vertical ? positions.bottom : positions.right
        const crossInside = Math.max(0, Math.min(crossEnd, vertical ? lines.bottom : lines.right) - Math.max(crossStart, vertical ? lines.top : lines.left)) / (crossEnd - crossStart)
        const safeSpan = before ? Math.min(safeEnd, alongEnd) - safeStart : safeEnd - Math.max(safeStart, alongStart)
        if (safeSpan <= 0 || crossInside <= 0) return [target]
        thresholdLine = before ? alongEnd - safeSpan * crossInside / policy.minimumCoreInsideRatio : alongStart + safeSpan * crossInside / policy.minimumCoreInsideRatio
        if (before ? thresholdLine > lines[edge] : thresholdLine < lines[edge]) return [target]
      }
      // Keep only native pixels strictly beyond the decision line. The other axis follows the entity, independently of the wide search strip.
      const dimension = vertical ? width : height
      const cut = (before ? Math.floor(thresholdLine * dimension) : Math.ceil(thresholdLine * dimension)) / dimension
      const crossPadX = strict ? padX : Math.max(padX, (envelope.right - envelope.left) / 2)
      const crossPadY = strict ? padY : Math.max(padY, (envelope.bottom - envelope.top) / 2)
      const crossLeft = Math.max(0, envelope.left - crossPadX), crossTop = Math.max(0, envelope.top - crossPadY)
      const crossRight = Math.min(1, envelope.right + crossPadX), crossBottom = Math.min(1, envelope.bottom + crossPadY)
      const exterior = vertical
        ? { x: before ? x : cut, y: crossTop, width: before ? cut - x : right - cut, height: crossBottom - crossTop }
        : { x: crossLeft, y: before ? y : cut, width: crossRight - crossLeft, height: before ? cut - y : bottom - cut }
      const contested = strict
        ? observations.some(box => Math.abs(box[edge] - thresholdLine) * dimension <= 1)
          || earlier.some(other => (edgePositions(other.rect)[edge] - thresholdLine) * (positions[edge] - thresholdLine) < 0)
        : earlier.some(other => subjectOutside(other, settings))
      return exterior.width > 0 && exterior.height > 0 ? [target, { ...target, outsideOnly: true as const, thresholdLine, ...(contested ? { contestedClearance: true as const } : {}), rect: exterior }] : [target]
    })
  }).sort((first, second) => second.overflow - first.overflow).map(({ overflow: _overflow, ...target }) => target)
  const required = [...foliageTargets, ...groupTargets.filter(target => !foliageTargets.some(leaf => leaf.regionIndex === target.regionIndex && leaf.edge === target.edge))]
  return [...required, ...safetyTargets.filter(target => !required.some(row => row.regionIndex === target.regionIndex && row.edge === target.edge && !('outsideOnly' in target)))]
}

function projectCropRect({ x, y, width, height }: ActualRegion['rect'], crop: PixelRect, settings: WallpaperSettings): ActualRegion['rect'] {
  return { x: (x * settings.width - crop.x) / crop.width, y: (y * settings.height - crop.y) / crop.height,
    width: width * settings.width / crop.width, height: height * settings.height / crop.height }
}

function wallpaperSingleEdgeCrop(review: BalancedReview, settings: WallpaperSettings, sourceLayout: Extract<WallpaperSourceLayout, { alignment: 'subject-fill-v1' }>, minimumRetained: number): PixelRect | undefined {
  const regions = review.actualLayout.regions
  const policy = wallpaperPracticalAcceptance(settings)
  if (!policy || regions.some(region => region.role !== 'subject' || region.scope !== 'core' || region.safetyClass !== 'general' || region.layoutFocus)
    || !review.layoutChecks.length || review.layoutChecks.some(check => !check.startsWith('subject-overflow:'))) return undefined
  const { width, height } = settings, bounds = wallpaperProtectedBounds(settings)
  const lines = { left: bounds.critical.left / width, right: bounds.critical.right / width, top: bounds.top / height, bottom: bounds.critical.bottom / height }
  const exceeds = (region: ActualRegion, edge: SafetyEdge) => {
    const position = edgePositions(region.rect)[edge]
    return edge === 'left' || edge === 'top' ? position < lines[edge] : position > lines[edge]
  }
  const [edge, otherEdge] = safetyEdges.filter(edge => regions.some(region => exceeds(region, edge)))
  if (!edge || otherEdge) return undefined
  const horizontal = edge === 'left' || edge === 'right', leading = edge === 'left' || edge === 'top'
  const limits = regions.map(region => {
    const rect = region.rect
    const extent = edgePositions(rect)[edge]
    if (!exceeds(region, edge)) return extent
    // Reserve one source-coordinate pixel for rounding the viewport.
    const allowance = Math.max(0, (horizontal ? rect.width : rect.height) * (1 - policy.minimumCoreInsideRatio) - 1 / (horizontal ? width : height))
    return leading ? extent + allowance : extent - allowance
  })
  const retained = leading ? Math.min(...limits) / lines[edge] : (1 - Math.max(...limits)) / (1 - lines[edge])
  if (retained >= 1 || retained < Math.max(minimumRetained, sourceLayout.fill.minimumRetainedAxis)) return undefined
  const cropHeight = Math.floor(height * retained), cropWidth = Math.round(cropHeight * width / height)
  const crop = { x: horizontal ? leading ? 0 : width - cropWidth : Math.round((width - cropWidth) / 2),
    y: horizontal ? Math.round((height - cropHeight) / 2) : leading ? 0 : height - cropHeight, width: cropWidth, height: cropHeight }
  const projected = regions.map(region => ({ ...region, rect: projectCropRect(region.rect, crop, settings) }))
  if (projected.some(({ rect }) => rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1)) return undefined
  return wallpaperActualBoundary({ ...review.actualLayout, regions: projected }, review.subjectIntegrity.mode, settings, sourceLayout).hard.length ? undefined : crop
}

/**
 * @param review Review of the unaltered, complete generated canvas.
 * @param plan Frozen observations used to exclude intentional framing and visible accessories.
 * @param settings Frozen safety and canvas dimensions.
 * @param sourceLayout Projected subject position and retained-background requirements.
 * @returns A whole-frame crop that preserves complete subjects and satisfies the projected safety check. Final pixels still require independent review.
 */
export function wallpaperRedrawPlacementCrop(review: BalancedReview, plan: WallpaperPlan, settings: WallpaperSettings, sourceLayout?: WallpaperSourceLayout): PixelRect | undefined {
  if (sourceLayout?.alignment !== 'subject-fill-v1' || settings.processing?.clockContrast || review.practicalReview?.version !== 'practical-v2'
    || review.subjectIntegrity.output.extent !== 'complete' || review.modelProtectionCheck.result !== 'satisfied'
    || review.sourceCorrespondence.result !== 'satisfied' || review.sourceRepair.result !== 'satisfied'
    || Object.entries(review.checks).some(([key, check]) => key !== 'protection' && check.result !== 'satisfied')
    || sourceLayout.expectedActionParts?.length || sourceLayout.expectedFrameContacts?.length || plan.objectRoles?.some(role => role.role !== 'supporting' && (role.sourceEdges.length || role.sourceIntent?.visibleAccessoryExtent))) return undefined
  const expansion = wallpaperExpansionReview(settings)
  if (expansion?.version === 'expansion-first-v2' && (review.subjectIntegrity.mode === 'single' || review.subjectIntegrity.mode === 'group')
    && review.layoutChecks.some(check => check.startsWith('subject-overflow:'))) return wallpaperSingleEdgeCrop(review, settings, sourceLayout, expansion.minimumPlannedScaleRatio)
  if (review.subjectIntegrity.mode !== 'single' || !review.layoutChecks.some(check => check.startsWith('subject-center-drift:'))) return undefined
  const [region, otherRegion] = review.actualLayout.regions
  const [expected, otherExpected] = sourceLayout.expectedSubjects ?? []
  if (!region?.entityId || !expected?.wholeRect || otherRegion || otherExpected || region.role !== 'subject' || region.scope !== 'core'
    || region.entityId !== expected.entityId || region.safetyClass !== 'general' || region.layoutFocus
    || review.layoutChecks.some(check => !check.startsWith('subject-center-drift:') && !['subject-too-small', `subject-too-small:${region.name}`, `subject-overflow:${region.name}`].includes(check))) return undefined
  const bounds = wallpaperProtectedBounds(settings), tolerance = sourceLayout.fill.maximumCenterDrift
  const fitAxis = (start: number, span: number, plannedStart: number, plannedSpan: number, limit: number) => {
    const current = start + span / 2, center = plannedStart + plannedSpan / 2, difference = current - center
    const target = Math.abs(difference) <= limit ? current : center + Math.sign(difference) * limit / 2
    return { current, target, retained: Math.min(current / target, (1 - current) / (1 - target)) }
  }
  const horizontal = fitAxis(region.rect.x, region.rect.width, expected.rect.x, expected.rect.width, settings.safe.width * tolerance / settings.width)
  const vertical = fitAxis(region.rect.y, region.rect.height, expected.rect.y, expected.rect.height, (bounds.critical.bottom - bounds.top) * tolerance / settings.height)
  const height = Math.floor(settings.height * Math.min(horizontal.retained, vertical.retained))
  const width = Math.round(height * settings.width / settings.height)
  if (height >= settings.height || width / settings.width < sourceLayout.fill.minimumRetainedAxis || height / settings.height < sourceLayout.fill.minimumRetainedAxis) return undefined
  const origin = (current: number, target: number, frame: number, span: number) => Math.max(0, Math.min(frame - span, Math.round(current * frame - target * span)))
  const crop = { x: origin(horizontal.current, horizontal.target, settings.width, width), y: origin(vertical.current, vertical.target, settings.height, height), width, height }
  const rect = projectCropRect(region.rect, crop, settings)
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1) return undefined
  const projected = { ...review.actualLayout, regions: [{ ...region, rect }] }
  if (wallpaperActualBoundary(projected, 'single', settings, sourceLayout).hard.length) return undefined
  return crop
}

/** @param native Review before whole-frame resampling. @param final Independent review of the delivered pixels. @param settings Frozen canvas and crop margin. @param crop A saved whole-frame placement crop, if applied. @returns Both edges of each disputed center axis for a single whole subject. Native measurements only locate crops. */
export function wallpaperPlacementReviewRegions(native: BalancedReview, final: BalancedReview, settings: WallpaperSettings, crop?: PixelRect): WallpaperSafetyCropTarget[] {
  const policy = wallpaperPracticalAcceptance(settings)
  const source = settings.sourceIntentPolicy
  if (policy?.version !== 'practical-v2' || source?.alignment !== 'subject-fill-v1' || !wallpaperBoundaryReviewNeeded(final)) return []
  const drift = final.layoutChecks.find(check => check.startsWith('subject-center-drift:'))
  const axes = drift && /^subject-center-drift:(-?\d+),(-?\d+)$/.exec(drift)
  if (!axes) return []
  const isSubject = (region: ActualRegion) => region.role === 'subject' && region.scope === 'core'
  const [before, otherBefore] = native.actualLayout.regions.filter(isSubject)
  const candidates = final.actualLayout.regions.flatMap((region, regionIndex) => isSubject(region) ? [{ region, regionIndex }] : [])
  const [after, otherAfter] = candidates
  if (!before?.entityId || !after || otherBefore || otherAfter || after.region.entityId !== before.entityId
    || before.safetyClass !== 'general' || after.region.safetyClass !== 'general' || before.layoutFocus || after.region.layoutFocus) return []
  const padding = boundaryCropPadding(settings, policy)
  const { region, regionIndex } = after, original = edgePositions(crop ? projectCropRect(before.rect, crop, settings) : before.rect), output = edgePositions(region.rect)
  const offsetX = (original.left + original.right - output.left - output.right) / 2 * settings.width
  const offsetY = (original.top + original.bottom - output.top - output.bottom) / 2 * settings.height
  const safe = wallpaperProtectedBounds(settings), tolerance = source.fill.maximumCenterDrift
  // The stored drift rounds to whole pixels. Recheck the failed axis when the earlier estimate could clear it.
  const disputed = (measured: number, offset: number, limit: number) => Math.abs(measured) + 0.5 >= limit && Math.abs(measured + offset) < limit + 0.5
  const left = Math.min(original.left, output.left), right = Math.max(original.right, output.right)
  const top = Math.min(original.top, output.top), bottom = Math.max(original.bottom, output.bottom)
  const dx = padding / settings.width, dy = padding / settings.height
  const crops: WallpaperSafetyCropTarget[] = []
  const add = (edge: SafetyEdge, left: number, top: number, right: number, bottom: number) => {
    const x = Math.max(0, left - dx), y = Math.max(0, top - dy)
    crops.push({ regionIndex, entityId: region.entityId, name: region.name, role: region.role, edge,
      rect: { x, y, width: Math.min(1, right + dx) - x, height: Math.min(1, bottom + dy) - y } })
  }
  if (disputed(Number(axes[2]), offsetY, (safe.critical.bottom - safe.top) * tolerance)) {
    add('top', left, top, right, Math.max(original.top, output.top))
    add('bottom', left, Math.min(original.bottom, output.bottom), right, bottom)
  }
  if (disputed(Number(axes[1]), offsetX, settings.safe.width * tolerance)) {
    add('left', left, top, Math.max(original.left, output.left), bottom)
    add('right', Math.min(original.right, output.right), top, right, bottom)
  }
  return crops
}

const exteriorCropInstruction = '对 outsideOnly 实拍条带逐段寻找指定实体本身。汽车条带从安全线开始，普通主体的条带从决定97%面积是否达标的界线开始。沿尾梢的浅色毛束、鞋尖、绿叶或相连保险杠逐段追踪。任何一段存在属于指定部位的像素，标出证据像素的实际位置 measured；整条没有该主体才填 clear，身份或边缘不明填 unknown。不要默认填裁片中心。量狗时沿轮廓追到尾梢，车辆含光亮镀铬边，排除地面反光或阴影。'

/** Recheck the two actual extrema of the same physical subject without changing other completed review checks. */
export const wallpaperPlacementCropReviewInstruction = '只量这张交付成品的主体位置，返回boundaryCrops。borderlineRegions逐张指定成品真实局部图的冻结主体和待量一侧。先在完整成品中认出该主体，再在对应actual-wallpaper-detail-only定位其实际最外端。按原图冻结的主体范围量紧框，主角自身固有的组成要量入，另列的承托物、其他陪衬、影子和空背景排除。上缘和下缘须量同一主体的完整可见范围，保留实际边缘，即使已越过安全线。每项按顺序填写绑定的cropImageVersionId和edge，能明确定位才填measured及相对于该局部裁片左上角的0到1坐标point。只取画面中的真实像素端点。端点不在局部图内、主体相混或看不清时填unknown。' + exteriorCropInstruction

/** Boundary measurements refer to the independently supplied local crop rather than the overview box. */
export const wallpaperSafetyCropReviewInstruction = '回复包含review和boundaryCrops。review按原要求填写。boundaryCrops按局部图顺序逐张填写，只从对应actual-wallpaper-detail-only量指定冻结实体的最远可见像素。目标的edge、实体和完整画布裁片范围由borderlineRegions给出，imageRepresentations给出真实裁片ID和坐标。逐条报告cropImageVersionId、edge、status。看得清最远端才填measured和point（相对于该裁片左上角的0到1坐标）；看不清、实体身份无法核实、端点已离开裁片时填unknown。请量实体实际末端，不用安全线或先前估计框代替末端，量指定主体自身的可见轮廓，排除其他主体、倒影和背景。' + exteriorCropInstruction

function attachedSafetyCrops(prepared: VisionInput, selected: readonly WallpaperSafetyCropTarget[]) {
  const rect = wallpaperSourceReviewV4Schema.shape.actualLayout.shape.regions.element.shape.rect
  const views = z.object({ imageRepresentations: z.array(z.object({ imageVersionId: z.string(), sourceImageVersionId: z.string().optional(), sourceRect: rect.optional() })) }).parse(prepared.usage).imageRepresentations
  const outputImage = prepared.images.find(image => image.role === 'actual-wallpaper')
  const available = prepared.images.filter(image => image.role === 'actual-wallpaper-detail-only').slice(0, selected.length)
  return selected.map((target, index) => {
    const image = available[index]
    const view = image && views.find(row => row.imageVersionId === image.imageVersionId && row.sourceImageVersionId === outputImage?.imageVersionId)
    if (!view?.sourceRect) throw new MediaError('vision-detail-unavailable', 'wallpaper-review', false, 'The safety check requires a saved crop of the actual candidate.', 'Retry review with the saved actual candidate available.')
    return { imageVersionId: view.imageVersionId, edge: target.edge, rect: view.sourceRect, outsideOnly: target.outsideOnly === true }
  })
}

/** @param prepared Saved vision representations for this exact actual-image request. @param selected Crop targets in the same order they were dispatched. @returns The model wire schema binding each endpoint to an exact attached crop. */
export function wallpaperSafetyCropEvidenceSchema(prepared: VisionInput, selected: readonly WallpaperSafetyCropTarget[]) {
  const attached = attachedSafetyCrops(prepared, selected)
  return z.array(safetyCropObservation).length(attached.length).describe(`Exact crop bindings, in array order: ${JSON.stringify(attached.map(({ imageVersionId, edge, outsideOnly }) => ({ cropImageVersionId: imageVersionId, edge, outsideOnly })))}`).superRefine((rows, ctx) => {
    for (const [index, crop] of attached.entries()) {
      const row = rows[index]
      if (row?.status === 'clear' && !crop.outsideOnly) ctx.addIssue({ code: 'custom', path: [index], message: 'Only a fully inspected exterior-only crop can report clear.' })
      if (row && (row.cropImageVersionId !== crop.imageVersionId || row.edge !== crop.edge)) ctx.addIssue({ code: 'custom', path: [index], message: 'Use the attached actual-image crop ID and its specified safety edge in the stated order.' })
    }
  })
}

interface LocalSafetyReview {
  settings: WallpaperSettings
  sourceLayout?: WallpaperSourceLayout | undefined
  expected: readonly WallpaperSafetyCropTarget[]
  evidence: readonly WallpaperSafetyCropEvidence[]
  prepared?: VisionInput | undefined
  extentOnly?: true
}

function applyLocalSafetyEvidence(initial: BalancedReview, measured: BalancedReview, local: LocalSafetyReview): BalancedReview {
  if (initial.actualLayout.imageVersionId !== measured.actualLayout.imageVersionId) return initial
  const regions = [...measured.actualLayout.regions]
  const crops = local.prepared && local.evidence.length ? attachedSafetyCrops(local.prepared, local.expected.slice(0, local.evidence.length)) : []
  const unconfirmed: string[] = []
  let confirmedExterior = false
  for (const [targetIndex, target] of local.expected.entries()) {
    const prior = initial.actualLayout.regions[target.regionIndex]!
    const matches = regions.flatMap((region, index) => region.role === target.role && region.scope === 'core' && (target.entityId ? region.entityId === target.entityId : region.name === target.name) ? [index] : [])
    const index = matches.find(index => regions[index]?.name === target.name) ?? (matches.length === 1 ? matches[0] : undefined)
    const current = index === undefined ? prior : regions[index]!
    const positions = edgePositions(current.rect), originalEdges = edgePositions(prior.rect)
    const crop = crops[targetIndex], observation = local.evidence[targetIndex]
    if (target.outsideOnly && crop && observation?.status === 'clear') {
      const alongX = target.edge === 'left' || target.edge === 'right'
      const dimension = alongX ? local.settings.width : local.settings.height
      const inward = target.edge === 'left' || target.edge === 'top' ? 1 : -1
      // An empty exterior strip cannot resolve conflicting measurements within the configured native inspection window.
      if (target.contestedClearance && target.thresholdLine !== undefined
        && (positions[target.edge] - target.thresholdLine) * dimension * inward <= (local.settings.processing?.layoutInsetPixels ?? 0))
        unconfirmed.push(`${target.name} · ${target.edge}`)
      continue
    }
    let coordinate: number | undefined
    if (crop && observation?.status === 'measured') {
      const alongX = target.edge === 'left' || target.edge === 'right'
      const point = alongX ? observation.point.x : observation.point.y
      const origin = alongX ? crop.rect.x : crop.rect.y, span = alongX ? crop.rect.width : crop.rect.height
      const projected = origin + point * span
      // A clipped crop edge does not establish the outermost pixel of the protected part.
      if (target.outsideOnly) {
        const leading = target.edge === 'left' || target.edge === 'top'
        const bounds = wallpaperProtectedBounds(local.settings)
        const dimension = alongX ? local.settings.width : local.settings.height
        const limit = target.thresholdLine !== undefined ? target.thresholdLine * dimension : target.edge === 'top' ? bounds.top : bounds.critical[target.edge]
        if (leading ? projected <= limit / dimension : projected >= limit / dimension) {
          coordinate = leading ? Math.min(positions[target.edge], projected, (limit - 0.5) / dimension) : Math.max(positions[target.edge], projected, (limit + 0.5) / dimension)
        }
      } else if (point > 0 && point < 1 || projected === 0 || projected === 1) coordinate = target.component ? Math.min(positions.top, originalEdges.top, projected) : projected
    }
    const corrected = { ...positions, [target.edge]: coordinate ?? (target.outsideOnly ? positions[target.edge] : originalEdges[target.edge]) }
    const valid = corrected.left < corrected.right && corrected.top < corrected.bottom
    if (coordinate !== undefined && valid && index !== undefined && (target.outsideOnly || target.component && coordinate * local.settings.height < wallpaperProtectedBounds(local.settings).top)) confirmedExterior = true
    if (coordinate === undefined || !valid || index === undefined) unconfirmed.push(`${target.name} · ${target.edge}`)
    const vertical = target.edge === 'left' || target.edge === 'right'
    const rect = !valid ? prior.rect : vertical ? { ...current.rect, x: corrected.left, width: corrected.right - corrected.left } : { ...current.rect, y: corrected.top, height: corrected.bottom - corrected.top }
    if (index === undefined) regions.push({ ...prior, rect })
    else regions[index] = { ...current, rect }
  }
  const actualLayout = { ...measured.actualLayout, regions }
  const preserved = new Set(measured.practicalReview?.sourcePreservation?.filter(row => row.framing.result === 'satisfied' && row.appearance.result === 'satisfied' && row.relationships.result === 'satisfied').map(row => row.entityId))
  const boundary = wallpaperActualBoundary(actualLayout, measured.subjectIntegrity.mode, local.settings, local.sourceLayout, preserved)
  const checks = { ...measured.checks }
  for (const key of [...wallpaperReviewKeys, 'clarity'] as const) if (key !== 'protection' && initial.checks[key].result === 'violated') checks[key] = initial.checks[key]
  const preserve = initial.issues.filter(issue => issue.check !== 'protection' && (issue.check === 'sourceRepair' || issue.check === 'sourceCorrespondence' ? initial[issue.check] : initial.checks[issue.check]).result === 'violated')
  const issues = [...preserve, ...measured.issues.filter(issue => issue.check !== 'protection' && !preserve.some(prior => prior.check === issue.check && prior.reason === issue.reason))]
  const reason = unconfirmed.length ? `安全边缘局部尚未确认（${unconfirmed.slice(0, 4).join('、')}），已保留实际成品和先前测量。` : undefined
  if (reason && !(confirmedExterior && boundary.hard.length)) {
    checks.protection = { result: 'unknown', reason }
    issues.unshift({ kind: 'unknown', check: 'protection', code: 'other', reason })
  } else if (boundary.hard.length) {
    checks.protection = { result: 'violated', reason: boundary.hard.join('；') }
    issues.unshift({ kind: 'layout', check: 'protection', code: 'other', reason: checks.protection.reason })
  } else checks.protection = measured.modelProtectionCheck
  return { ...measured, actualLayout, checks, issues: issues.slice(0, 32), layoutChecks: boundary.hard, layoutWarnings: boundary.warnings,
    sourceRepair: initial.sourceRepair.result === 'violated' ? initial.sourceRepair : measured.sourceRepair,
    sourceCorrespondence: initial.sourceCorrespondence.result === 'violated' ? initial.sourceCorrespondence : measured.sourceCorrespondence,
    ...(reason && measured.practicalReview ? { practicalReview: { ...measured.practicalReview, uncertainties: [reason, ...measured.practicalReview.uncertainties.slice(0, 3)] } } : {}),
  }
}

/** @param review Earlier full-frame findings. @param measured Independent high-effort review using actual pixels and a separate safety guide. @param requestId Logged boundary request. @param local Required crop evidence for vulnerable protected edges in current tasks. @returns The measured review with the exact protected endpoints independently verified or explicitly unresolved. */
export function applyWallpaperBoundaryDetail(review: BalancedReview, measured: BalancedReview, requestId: string, local?: LocalSafetyReview): BalancedReview {
  if (!local?.expected.length && !wallpaperBoundaryReviewNeeded(review)) return review
  const checked = local?.expected.length ? applyLocalSafetyEvidence(review, measured, local) : measured
  const examinedChecks = local?.extentOnly ? ['protection'] as const : ['protection', 'composition', 'subject', 'sourceRepair'] as const
  const result = { ...checked, criticalDetail: { requestId, examinedChecks: [...examinedChecks], resolvedChecks: examinedChecks.filter(key => (key === 'sourceRepair' ? checked.sourceRepair : checked.checks[key]).result !== 'unknown') } }
  return review.clockContrast ? applyWallpaperClockContrast(result, review.clockContrast) : result
}

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

/** @param original Saved medium review. @param detail Independently checked high-effort local pixels. @param settings Frozen bounds. @param requestId Logged local request. @param sourceLayout Reference geometry for the original complete output. @returns Review that changes only unresolved critical findings and retains earlier failures and layout. */
export function applyWallpaperCriticalDetail(original: BalancedReview, detail: BalancedReview, settings: WallpaperSettings, requestId: string, sourceLayout?: WallpaperSourceLayout): BalancedReview {
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
  const preservation = (resolved.includes('sourceCorrespondence') ? detail : original).practicalReview?.sourcePreservation
  const merged = applyWallpaperSourceReview(raw, original.sourceRepairAuthorized === true, settings, sourceLayout?.alignment === 'subject-fill-v1' ? sourceLayout : undefined, preservation)
  return wallpaperStoredSourceReviewV4Schema.parse({ ...merged, criticalDetail: { requestId, examinedChecks: targets, resolvedChecks: resolved } })
}
