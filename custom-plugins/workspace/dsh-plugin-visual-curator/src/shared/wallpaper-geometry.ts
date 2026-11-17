/** Source transforms and protected-region checks run without image decoding. */
import type { WallpaperItem, WallpaperPlan, WallpaperSettings } from './wallpaper.ts'
import { wallpaperGenerativeRepair, wallpaperReviewNeedsSubjectEdit, wallpaperPracticalAcceptance } from './wallpaper-policy.ts'
import { CuratorError } from './errors.ts'

/** Locate source-frame contacts that need bounded continuation after placing a cropped object inside the canvas.
 * @param observed Source truncations and protected rectangles; background crops alone grant no subject edits.
 * @param settings Frozen generated-repair and frame-continuation authorization.
 * @returns Source edges requiring extension room, or none when continuation is disabled or no protected object touches the frame.
 */
export function wallpaperSourceExtensionEdges(observed: Pick<WallpaperPlan, 'truncations' | 'regions' | 'objectRoles'>, settings: WallpaperSettings): ('left' | 'top' | 'right' | 'bottom')[] {
  if (!wallpaperGenerativeRepair(settings) || !settings.sourceFrameRepair?.enabled) return []
  if (observed.objectRoles?.length) return (['left', 'top', 'right', 'bottom'] as const).filter(edge => observed.objectRoles!.some(object => object.sourceEdges.includes(edge)))
  if (!observed.truncations.length) return []
  const regions = observed.regions.filter(region => region.role !== 'anchor')
  return (['left', 'top', 'right', 'bottom'] as const).filter(edge => regions.some(({ rect }) => edge === 'left' ? rect.x === 0 : edge === 'top' ? rect.y === 0 : edge === 'right' ? rect.x + rect.width >= 1 : rect.y + rect.height >= 1))
}

type SourceEdge = 'left' | 'top' | 'right' | 'bottom'

/** One source-frame contact after placement; only contacts inside the delivered frame need a new visible ending. */
export interface WallpaperSourceContinuationTarget {
  readonly entityId: string
  readonly name: string
  readonly edge: SourceEdge
  readonly disposition: 'interior' | 'final-frame-crop'
  readonly rect?: WallpaperPlan['regions'][number]['rect']
}

/** Classify each observed source-frame contact against the actual output frame.
 * @param plan Frozen source observation and placement. @param settings Output frame and repair policy. @param source Oriented source pixels used by the placement.
 * @returns Per-object contacts, including final-frame crops that must not be reconstructed inside the source.
 */
export function wallpaperSourceContinuationTargets(plan: WallpaperPlan, settings: WallpaperSettings, source: { width: number; height: number }): WallpaperSourceContinuationTarget[] {
  const edges = wallpaperSourceExtensionEdges(plan, settings)
  if (!edges.length) return []
  const width = Math.max(1, Math.round(source.width * plan.placement.scale)), height = Math.max(1, Math.round(source.height * plan.placement.scale))
  const positions = { left: plan.placement.left, top: plan.placement.top, right: plan.placement.left + width, bottom: plan.placement.top + height }
  const inside = (edge: SourceEdge, rect?: WallpaperPlan['regions'][number]['rect']) => {
    const contactInside = edge === 'left' || edge === 'right'
      ? positions[edge] > 0 && positions[edge] < settings.width
      : positions[edge] > 0 && positions[edge] < settings.height
    if (!contactInside || !rect) return contactInside
    return edge === 'left' || edge === 'right'
      ? plan.placement.top + (rect.y + rect.height) * height > 0 && plan.placement.top + rect.y * height < settings.height
      : plan.placement.left + (rect.x + rect.width) * width > 0 && plan.placement.left + rect.x * width < settings.width
  }
  const objects = plan.objectRoles?.length
    ? plan.objectRoles.map(object => ({ entityId: object.entityId, name: object.name, rect: object.rect, edges: object.sourceEdges }))
    : edges.map(edge => ({ entityId: `source-${edge}`, name: `Source ${edge} edge`, rect: undefined, edges: [edge] }))
  return objects.flatMap(object => object.edges.filter(edge => edges.includes(edge)).map(edge => ({
    entityId: object.entityId, name: object.name, edge, disposition: inside(edge, object.rect) ? 'interior' as const : 'final-frame-crop' as const,
    ...(object.rect ? { rect: object.rect } : {}),
  })))
}

/** @param plan Frozen placement. @param settings Output policy. @param source Reference dimensions. @returns Model-visible per-object edit permission without treating final-frame crops as interior defects. */
export function wallpaperSourceContinuationContext(plan: WallpaperPlan, settings: WallpaperSettings, source: { width: number; height: number }) {
  return { targets: wallpaperSourceContinuationTargets(plan, settings, source), marginPixels: settings.sourceFrameRepair?.marginPixels ?? 0 }
}

/** Map each internal source cut to a full-output crop for the independent native review.
 * @param plan Frozen placement and source object rectangles. @param settings Output frame. @param source Oriented source dimensions.
 * @returns Local views including generated pixels beyond the old cut and the adjacent source object.
 */
export function wallpaperSourceContinuationReviewRegions(plan: WallpaperPlan, settings: WallpaperSettings, source: { width: number; height: number }) {
  const width = Math.round(source.width * plan.placement.scale), height = Math.round(source.height * plan.placement.scale)
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  return wallpaperSourceContinuationTargets(plan, settings, source).filter(target => target.disposition === 'interior' && target.rect).map(target => {
    const object = target.rect!
    const left = (plan.placement.left + object.x * width) / settings.width
    const top = (plan.placement.top + object.y * height) / settings.height
    const right = (plan.placement.left + (object.x + object.width) * width) / settings.width
    const bottom = (plan.placement.top + (object.y + object.height) * height) / settings.height
    const x0 = clamp(left - (target.edge === 'left' ? 0.08 : 0.03))
    const y0 = clamp(top - (target.edge === 'top' ? 0.08 : 0.03))
    const x1 = clamp(right + (target.edge === 'right' ? 0.08 : 0.03))
    const y1 = clamp(bottom + (target.edge === 'bottom' ? 0.08 : 0.03))
    return { entityId: target.entityId, name: target.name, edge: target.edge, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }
  }).filter(target => target.rect.width > 0 && target.rect.height > 0)
}

/** Protect the whole observed object with strict core bounds when no smaller critical rectangle was identified.
 * @param plan Observed object mode and source rectangles.
 * @param settings Frozen acceptance; omitted policy retains historical whole-object protection.
 * @returns Original rectangles under practical acceptance, otherwise complete-object core protection when needed.
 */
export function wallpaperObjectProtectionRegions(plan: Pick<WallpaperPlan, 'mode' | 'regions'>, settings?: WallpaperSettings): WallpaperPlan['regions'] {
  if (settings && wallpaperPracticalAcceptance(settings)) return plan.regions
  if (!['single', 'group'].includes(plan.mode) || plan.regions.some(region => region.role === 'critical')) return plan.regions
  return [...plan.regions, ...plan.regions.filter(region => region.role === 'subject').map(region => ({ ...region, name: `${region.name} · complete-object core protection`, role: 'critical' as const }))]
}

/** Keep model instructions consistent with frozen object roles; Host-only core copies still constrain rendering.
 * @param plan Saved source observations and internal protection rectangles.
 * @returns Model-facing plan without critical copies of frozen primary subjects; the saved plan is unchanged.
 */
export function wallpaperModelPlan(plan: WallpaperPlan): WallpaperPlan {
  const objects = plan.objectRoles
  if (!objects) return plan
  return { ...plan, regions: plan.regions.filter(region => region.role !== 'critical' || !objects.some(object => object.role === 'primary' && object.entityId === region.entityId)) }
}

/** Fit an independently complete saved scene before extending newly exposed canvas.
 * @param prior Saved candidate and its actual output review.
 * @param settings Frozen repair authorization and safety bounds.
 * @returns Uniform candidate placement for layout or clock-background defects, or absence when subject, structure or image quality still needs repair.
 */
export function wallpaperCandidatePlacement(prior: Pick<WallpaperItem['attempts'][number], 'plan' | 'review' | 'outputId' | 'compositionMode'>, settings: WallpaperSettings): WallpaperPlan | undefined {
  const review = prior.review
  if (!wallpaperGenerativeRepair(settings) || prior.compositionMode !== 'generated-canvas-v1' || !prior.outputId || !review || !('reviewVersion' in review) || review.reviewVersion !== 'wallpaper-review-source-v4') return undefined
  if (Object.values(review.checks).some(check => check.result === 'unknown') || review.sourceRepair.result === 'unknown' || review.subjectIntegrity.task.result === 'unknown') return undefined
  if (review.subjectIntegrity.output.extent !== 'complete' || review.sourceCorrespondence.result !== 'satisfied' || wallpaperReviewNeedsSubjectEdit(review)) return undefined
  const issues = review.modelIssues.length ? review.modelIssues : review.issues
  const layoutDefect = review.layoutChecks.length > 0 || issues.some(issue => issue.kind === 'layout') || review.issues.some(issue => issue.kind === 'layout')
  if (review.checks.background.result === 'unknown') return undefined
  if (!issues.length || issues.some(issue => !['layout', 'readability', 'background'].includes(issue.kind))) return undefined
  if (Object.entries(review.checks).some(([key, check]) => !['subject', 'composition', 'protection', 'clock', 'readability', 'background'].includes(key) && check.result !== 'satisfied')) return undefined
  if ((review.subjectIntegrity.task.result !== 'satisfied' || review.sourceRepair.result !== 'satisfied') && !layoutDefect) return undefined
  if (review.actualLayout.regions.some(region => region.role === 'anchor' || region.role === 'critical' && region.scope !== 'core')) return undefined
  const region = ({ name, entityId, role, rect, safetyClass }: typeof review.actualLayout.regions[number]) => ({ name, ...(entityId ? { entityId } : {}), ...(safetyClass ? { safetyClass } : {}), role, rect: { ...rect } })
  const core = review.actualLayout.regions.filter(region => region.scope === 'core').map(region)
  if (!core.some(region => region.role === 'subject')) return undefined
  if (review.checks.background.result === 'violated') {
    const defects = review.modelIssues.filter(issue => issue.check === 'background')
    if (!defects.length || defects.some(issue => !issue.evidence || issue.evidence.kind !== 'background-artifact' || issue.evidence.imageVersionId !== review.actualLayout.imageVersionId)) return undefined
  }
  const regions = [...wallpaperObjectProtectionRegions({ mode: 'group', regions: core }, settings), ...(wallpaperPracticalAcceptance(settings) ? [] : review.actualLayout.regions.filter(region => region.scope === 'peripheral').map(region))]
  const observed = { ...prior.plan, imageVersionId: prior.outputId, mode: 'group' as const, evidence: review.sourceCorrespondence.reason, regions, objectRoles: prior.plan.objectRoles?.map(object => ({ ...object, sourceEdges: [] })), truncations: [], uncertainties: [],
    editPrompt: `保持已保存完整候选的对象、结构、取景、纹理和内部相对位置。按本轮参考画布提供的等比缩放定位要求，${review.checks.background.result === 'violated' ? '保护已验收主体和必要结构，仅修复已定位的背景缺陷并补全新露出的背景' : '只补新露出的外围背景'}${settings.processing?.clockContrast ? '，并按显式时钟规则改善顶部白色时间背景对比' : ''}；不要把中间画面放大铺满，不重画主体。`,
    reason: 'Uniform placement derived from independently reviewed candidate regions; subject and image quality remain subject to final review.' }
  const placement = layoutDefect ? fitWallpaperPlacement(settings, observed, settings, 'subject-first-v2') : { scale: 1, left: 0, top: 0 }
  if (layoutDefect && placement.scale === 1 && placement.left === 0 && placement.top === 0) return undefined
  const plan = { ...observed, placement }
  return wallpaperGeometry(settings, plan, settings).checks.length ? undefined : plan
}

/** @param settings Frozen output and allowed noncritical overflow. @returns Exact protected limits used by geometry checks and model input. */
export function wallpaperProtectedBounds(settings: WallpaperSettings) {
  const { safe } = settings
  return { top: safe.top + (settings.processing?.clockContrast ? settings.topBuffer : 0), clockBottom: safe.top,
    critical: { left: safe.left, right: safe.left + safe.width, bottom: safe.top + safe.height },
    subject: { left: safe.left - settings.sideOverflow, right: safe.left + safe.width + settings.sideOverflow, bottom: safe.top + safe.height + settings.bottomOverflow } }
}

/** @param settings Frozen canvas and protection policy. @returns Pixel and normalized bounds in the complete output coordinate system, independent of reference attachment resizing. */
export function wallpaperLayoutCoordinates(settings: WallpaperSettings) {
  const bounds = wallpaperProtectedBounds(settings)
  return { coordinateSystem: 'whole-output-top-left', canvas: { width: settings.width, height: settings.height },
    protectedPixels: { left: bounds.critical.left, top: bounds.top, right: bounds.critical.right, bottom: bounds.critical.bottom },
    protectedNormalized: { left: bounds.critical.left / settings.width, top: bounds.top / settings.height, right: bounds.critical.right / settings.width, bottom: bounds.critical.bottom / settings.height } }
}

/** Measure approximate subject placement without treating inferred rectangles as segmentation masks.
 * @param region Positioned subject core or indispensable detail in output pixels.
 * @param settings Frozen practical acceptance and exact safe rectangle.
 * @returns Blocking excess and nonblocking coordinate or small-placement warnings; strict policy has no result.
 */
export function wallpaperPracticalRegionBoundary(region: Pick<WallpaperPlan['regions'][number], 'name' | 'role' | 'safetyClass'> & { left: number; top: number; width: number; height: number }, settings: WallpaperSettings): { hard: string[]; warnings: string[] } | undefined {
  const policy = wallpaperPracticalAcceptance(settings)
  if (!policy) return undefined
  const bounds = wallpaperProtectedBounds(settings), tolerance = policy.version === 'practical-v1' ? policy.coordinateTolerancePixels : 0
  const right = region.left + region.width, bottom = region.top + region.height
  const overflow = { left: Math.max(0, bounds.critical.left - region.left), top: Math.max(0, bounds.top - region.top), right: Math.max(0, right - bounds.critical.right), bottom: Math.max(0, bottom - bounds.critical.bottom) }
  const hard: string[] = [], warnings: string[] = []
  if (region.left < -tolerance || region.top < -tolerance || right > settings.width + tolerance || bottom > settings.height + tolerance) hard.push(`clipped:${region.name}`)
  if (policy.version === 'practical-v2' && region.safetyClass === 'automobile') {
    if (Object.values(overflow).some(pixels => pixels > 0)) hard.push(`automobile-outside:${region.name}`)
  } else if (region.role !== 'subject') {
    if (Object.values(overflow).some(pixels => pixels > tolerance)) hard.push(`critical-outside:${region.name}`)
  } else {
    const insideWidth = Math.max(0, Math.min(right, bounds.critical.right + tolerance) - Math.max(region.left, bounds.critical.left - tolerance))
    const insideHeight = Math.max(0, Math.min(bottom, bounds.critical.bottom + tolerance) - Math.max(region.top, bounds.top - tolerance))
    const insideRatio = insideWidth * insideHeight / (region.width * region.height)
    const edgeRatio = Math.max(Math.max(0, overflow.left - tolerance) / region.width, Math.max(0, overflow.right - tolerance) / region.width, Math.max(0, overflow.top - tolerance) / region.height, Math.max(0, overflow.bottom - tolerance) / region.height)
    if (insideRatio < policy.minimumCoreInsideRatio || policy.version === 'practical-v1' && edgeRatio > policy.maximumCoreEdgeOverflowRatio) hard.push(`subject-overflow:${region.name}`)
  }
  if (!hard.length && Object.values(overflow).some(pixels => pixels > 0)) warnings.push(`core-outside:${region.name}`)
  return { hard, warnings }
}

/** Describe only positioned output regions; frozen object identities do not carry source rectangles into output coordinates.
 * @param plan Effective original or complete-candidate placement. @param source Effective reference dimensions. @param settings Frozen output geometry.
 * @returns Output-normalized protection regions and semantic object roles, with the applied source transform explicitly identified.
 */
export function wallpaperPositionedLayout(plan: WallpaperPlan, source: { width: number; height: number }, settings: WallpaperSettings) {
  const geometry = wallpaperGeometry(source, wallpaperModelPlan(plan), settings)
  return { ...wallpaperLayoutCoordinates(settings), sourceImageVersionId: plan.imageVersionId, referenceTransformAlreadyApplied: true,
    appliedSourceTransform: plan.placement,
    positionedRegions: geometry.regions.map(region => ({ name: region.name, entityId: region.entityId, role: region.role, ...(region.safetyClass ? { safetyClass: region.safetyClass } : {}),
      rect: { x: region.left / settings.width, y: region.top / settings.height, width: region.width / settings.width, height: region.height / settings.height } })),
    objectRoles: plan.objectRoles?.map(({ entityId, name, role, safetyClass }) => ({ entityId, name, role, ...(safetyClass ? { safetyClass } : {}) })) }
}

/** Fit all inferred protected regions with the same rounded source geometry used by rendering.
 * @param source Oriented original dimensions. @param observed Model observations without pixel placement. @param settings Frozen safe area and output size. @param policy V2 centers protected objects; V3 minimizes new pixels for a full-size healthy source.
 * @param extensionEdges Confirmed source edges requiring new pixels; omission reserves no additional space.
 * @returns Source placement that prefers a direct crop and never enlarges the original; semantic uncertainty remains in the plan.
 */
export function fitWallpaperPlacement(source: { width: number; height: number }, observed: Omit<WallpaperPlan, 'placement'>, settings: WallpaperSettings, policy: 'crop-first-v1' | 'subject-first-v2' | 'source-preserving-v3' = 'crop-first-v1', extensionEdges: readonly ('left' | 'top' | 'right' | 'bottom')[] = []): WallpaperPlan['placement'] {
  const bounds = wallpaperProtectedBounds(settings)
  const margin = settings.sourceFrameRepair?.marginPixels ?? 0
  const inset = settings.processing?.layoutInsetPixels ?? 0
  const edges = extensionEdges.length ? extensionEdges : wallpaperSourceExtensionEdges(observed, settings)
  const intervals = (scale: number) => {
    const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale))
    let left = -width + 1, right = settings.width - 1, top = -height + 1, bottom = settings.height - 1
    for (const region of observed.regions) {
      // Practical planning reserves the exact safe band; final review owns small overflow allowances.
      const base = wallpaperPracticalAcceptance(settings) || region.role !== 'subject' ? bounds.critical : bounds.subject
      const allowed = { left: base.left + inset + (edges.includes('left') ? margin : 0), right: base.right - inset - (edges.includes('right') ? margin : 0), bottom: base.bottom - inset - (edges.includes('bottom') ? margin : 0) }
      left = Math.max(left, Math.ceil(Math.max(0, allowed.left) - region.rect.x * width))
      right = Math.min(right, Math.floor(Math.min(settings.width, allowed.right) - (region.rect.x + region.rect.width) * width))
      top = Math.max(top, Math.ceil(bounds.top + inset + (edges.includes('top') ? margin : 0) - region.rect.y * height))
      bottom = Math.min(bottom, Math.floor(Math.min(settings.height, allowed.bottom) - (region.rect.y + region.rect.height) * height))
    }
    return { width, height, left, right, top, bottom, feasible: left <= right && top <= bottom }
  }
  const cropScale = Math.min(1, Math.max(settings.width / source.width, settings.height / source.height))
  const crop = intervals(cropScale)
  const canCrop = crop.feasible && crop.width >= settings.width && crop.height >= settings.height && Math.max(crop.left, settings.width - crop.width) <= Math.min(crop.right, 0) && Math.max(crop.top, settings.height - crop.height) <= Math.min(crop.bottom, 0)
  let scale = policy !== 'crop-first-v1' && (observed.mode === 'single' || observed.mode === 'group') && !canCrop ? 1 : cropScale, limits = intervals(scale)
  if (!limits.feasible) {
    let lower = 0, upper = scale
    // Rounded dimensions make feasibility monotonic; the final interval is checked again by wallpaperGeometry.
    for (let i = 0; i < 40; i++) { const middle = (lower + upper) / 2; if (intervals(middle).feasible) lower = middle; else upper = middle }
    scale = lower; limits = intervals(scale)
  }
  if (!scale || !limits.feasible) throw new CuratorError('constraint-conflict', 'wallpaper-layout', 'The protected regions cannot fit the frozen safe area.')
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)))
  const cropLeft = Math.max(limits.left, settings.width - limits.width), cropRight = Math.min(limits.right, 0)
  const cropTop = Math.max(limits.top, settings.height - limits.height), cropBottom = Math.min(limits.bottom, 0)
  if (limits.width >= settings.width && limits.height >= settings.height && cropLeft <= cropRight && cropTop <= cropBottom) return { scale, left: clamp((settings.width - limits.width) / 2, cropLeft, cropRight), top: clamp((settings.height - limits.height) / 2, cropTop, cropBottom) }
  if (policy === 'source-preserving-v3' && source.width === settings.width && source.height === settings.height && scale === 1) return { scale, left: clamp(0, limits.left, limits.right), top: clamp(0, limits.top, limits.bottom) }
  const subjects = observed.regions.filter(region => region.role === 'subject'), focus = subjects.length ? subjects : observed.regions
  const centerY = focus.length ? (Math.min(...focus.map(region => region.rect.y)) + Math.max(...focus.map(region => region.rect.y + region.rect.height))) / 2 : 0.5
  return { scale, left: clamp((settings.width - limits.width) / 2, limits.left, limits.right), top: clamp((bounds.top + bounds.critical.bottom) / 2 - centerY * limits.height, limits.top, limits.bottom) }
}

/** Measure the source transform and check the model's inferred regions.
 * @param source Oriented source dimensions.
 * @param plan Saved inferred layout.
 * @param settings Frozen output template.
 * @returns Measured canvas intersection, transformed regions and constraint failures.
 */
export function wallpaperGeometry(source: { width: number; height: number }, plan: WallpaperPlan, settings: WallpaperSettings) {
  const width = Math.max(1, Math.round(source.width * plan.placement.scale)), height = Math.max(1, Math.round(source.height * plan.placement.scale))
  const { left, top } = plan.placement, bounds = wallpaperProtectedBounds(settings)
  const target = { left: Math.max(0, left), top: Math.max(0, top), width: Math.min(settings.width, left + width) - Math.max(0, left), height: Math.min(settings.height, top + height) - Math.max(0, top) }
  if (target.width <= 0 || target.height <= 0) throw new CuratorError('invalid-input', 'wallpaper-layout', 'The source does not intersect the output canvas.')
  const regions = plan.regions.map(region => ({ ...region, left: left + region.rect.x * width, top: top + region.rect.y * height, width: region.rect.width * width, height: region.rect.height * height }))
  const checks: string[] = [], warnings: string[] = []
  if (plan.mode === 'uncertain' || plan.uncertainties.length && !wallpaperGenerativeRepair(settings) || !regions.length && (plan.mode === 'single' || plan.mode === 'group')) checks.push('uncertain-subject')
  const acceptance = wallpaperPracticalAcceptance(settings)
  if ((plan.mode === 'single' || plan.mode === 'group') && (!regions.some(region => region.role === 'subject') || !acceptance && !regions.some(region => region.role === 'critical'))) checks.push('missing-protected-regions')
  if (acceptance && (plan.mode === 'single' || plan.mode === 'group')) {
    const subjects = regions.filter(region => region.role === 'subject')
    const safeArea = settings.safe.width * (bounds.critical.bottom - bounds.top)
    const subjectArea = subjects.reduce((area, region) => area + region.width * region.height, 0)
    if (subjects.length && Math.min(subjectArea, safeArea) < safeArea * acceptance.minimumCoreSafeAreaRatio) checks.push('subject-too-small')
  }
  for (const region of regions) {
    const practical = wallpaperPracticalRegionBoundary(region, settings)
    if (practical) { checks.push(...practical.hard); warnings.push(...practical.warnings); continue }
    const right = region.left + region.width, bottom = region.top + region.height
    if (region.left < 0 || region.top < 0 || right > settings.width || bottom > settings.height) checks.push(`clipped:${region.name}`)
    if (region.top < bounds.clockBottom) checks.push(`${settings.processing?.clockContrast ? 'clock-overlap' : 'safe-top-overlap'}:${region.name}`)
    else if (region.top < bounds.top) checks.push(`top-buffer-overlap:${region.name}`)
    const critical = region.role === 'critical' || region.role === 'anchor'
    if (critical && (region.left < bounds.critical.left || right > bounds.critical.right || bottom > bounds.critical.bottom)) checks.push(`critical-outside:${region.name}`)
    if (!critical && (region.left < bounds.subject.left || right > bounds.subject.right || bottom > bounds.subject.bottom)) checks.push(`subject-overflow:${region.name}`)
  }
  return { width, height, left, top, target, regions, checks: [...new Set(checks)], warnings: [...new Set(warnings)], needsOutpaint: target.width * target.height < settings.width * settings.height }
}
