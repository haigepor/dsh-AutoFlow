/** Source transforms and protected-region checks run without image decoding. */
import type { WallpaperItem, WallpaperPlan, WallpaperSettings } from './wallpaper.ts'
import { wallpaperGenerativeRepair, wallpaperReviewNeedsSubjectEdit } from './wallpaper-policy.ts'
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
 * @returns Original rectangles plus complete-object core protection, without inventing unobserved structure.
 */
export function wallpaperObjectProtectionRegions(plan: Pick<WallpaperPlan, 'mode' | 'regions'>): WallpaperPlan['regions'] {
  if (!['single', 'group'].includes(plan.mode) || plan.regions.some(region => region.role === 'critical')) return plan.regions
  return [...plan.regions, ...plan.regions.filter(region => region.role === 'subject').map(region => ({ ...region, name: `${region.name} · complete-object core protection`, role: 'critical' as const }))]
}

/** Fit an independently complete saved scene before extending newly exposed canvas.
 * @param prior Saved candidate and its actual output review.
 * @param settings Frozen repair authorization and safety bounds.
 * @returns Uniform candidate placement for layout or clock-background defects, or absence when subject, structure or image quality still needs repair.
 */
export function wallpaperCandidatePlacement(prior: Pick<WallpaperItem['attempts'][number], 'plan' | 'review' | 'outputId' | 'compositionMode'>, settings: WallpaperSettings): WallpaperPlan | undefined {
  const review = prior.review
  if (!wallpaperGenerativeRepair(settings) || prior.compositionMode !== 'generated-canvas-v1' || !prior.outputId || !review || !('reviewVersion' in review) || review.reviewVersion !== 'wallpaper-review-source-v4') return undefined
  if (review.subjectIntegrity.output.extent !== 'complete' || review.sourceCorrespondence.result !== 'satisfied' || wallpaperReviewNeedsSubjectEdit(review)) return undefined
  const issues = review.modelIssues.length ? review.modelIssues : review.issues
  const layoutDefect = issues.some(issue => issue.kind === 'layout')
  if (!issues.length || issues.some(issue => issue.kind !== 'layout' && issue.kind !== 'readability')) return undefined
  if (Object.entries(review.checks).some(([key, check]) => !['subject', 'composition', 'protection', 'clock', 'readability'].includes(key) && check.result !== 'satisfied')) return undefined
  if ((review.subjectIntegrity.task.result !== 'satisfied' || review.sourceRepair.result !== 'satisfied') && !review.modelIssues.some(issue => issue.kind === 'layout')) return undefined
  if (review.actualLayout.regions.some(region => region.role === 'anchor' || region.role === 'critical' && region.scope !== 'core')) return undefined
  const region = ({ name, entityId, role, rect }: typeof review.actualLayout.regions[number]) => ({ name, ...(entityId ? { entityId } : {}), role, rect: { ...rect } })
  const core = review.actualLayout.regions.filter(region => region.scope === 'core').map(region)
  if (!core.some(region => region.role === 'subject')) return undefined
  const regions = [...wallpaperObjectProtectionRegions({ mode: 'group', regions: core }), ...review.actualLayout.regions.filter(region => region.scope === 'peripheral').map(region)]
  const observed = { ...prior.plan, imageVersionId: prior.outputId, mode: 'group' as const, evidence: review.sourceCorrespondence.reason, regions, objectRoles: prior.plan.objectRoles?.map(object => ({ ...object, sourceEdges: [] })), truncations: [], uncertainties: [],
    editPrompt: `保持已保存完整候选的对象、结构、取景、纹理和内部相对位置。整幅画面已按实际主体框等比缩放定位，只补新露出的外围背景${settings.processing?.clockContrast ? '，并按显式时钟规则改善顶部白色时间背景对比' : ''}；不要把中间画面放大铺满，不重画主体。`,
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
      const base = region.role === 'subject' ? bounds.subject : bounds.critical
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
  const checks: string[] = []
  if (plan.mode === 'uncertain' || plan.uncertainties.length && !wallpaperGenerativeRepair(settings) || !regions.length) checks.push('uncertain-subject')
  if ((plan.mode === 'single' || plan.mode === 'group') && (!regions.some(region => region.role === 'subject') || !regions.some(region => region.role === 'critical'))) checks.push('missing-protected-regions')
  for (const region of regions) {
    const right = region.left + region.width, bottom = region.top + region.height
    if (region.left < 0 || region.top < 0 || right > settings.width || bottom > settings.height) checks.push(`clipped:${region.name}`)
    if (region.top < bounds.clockBottom) checks.push(`${settings.processing?.clockContrast ? 'clock-overlap' : 'safe-top-overlap'}:${region.name}`)
    else if (region.top < bounds.top) checks.push(`top-buffer-overlap:${region.name}`)
    const critical = region.role === 'critical' || region.role === 'anchor'
    if (critical && (region.left < bounds.critical.left || right > bounds.critical.right || bottom > bounds.critical.bottom)) checks.push(`critical-outside:${region.name}`)
    if (!critical && (region.left < bounds.subject.left || right > bounds.subject.right || bottom > bounds.subject.bottom)) checks.push(`subject-overflow:${region.name}`)
  }
  return { width, height, left, top, target, regions, checks: [...new Set(checks)], needsOutpaint: target.width * target.height < settings.width * settings.height }
}
