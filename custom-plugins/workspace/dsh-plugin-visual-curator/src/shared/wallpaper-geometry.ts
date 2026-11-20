/** Source transforms and protected-region checks run without image decoding. */
import type { WallpaperFramingDiagnostics, WallpaperItem, WallpaperObjectRole, WallpaperPlan, WallpaperSettings } from './wallpaper.ts'
import { wallpaperExpansionReview, wallpaperGenerativeRepair, wallpaperReviewNeedsSubjectEdit, wallpaperPracticalAcceptance } from './wallpaper-policy.ts'
import { CuratorError } from './errors.ts'

/** Explicit new-task layout requirements; omission preserves frozen historical geometry rules. */
export type WallpaperSourceLayout = NonNullable<WallpaperSettings['sourceIntentPolicy']> & {
  /** Planned output bounds for position and optional matched focus for size measurement. */
  expectedSubjects?: readonly { entityId: string; rect: Rect; focus?: Rect; wholeRect?: Rect; hasAccessory?: true; attachedFoliage?: true }[]
  /** The original has two complete, vertically separated primary subjects with overlapping horizontal spans. */
  stackedSubjects?: true
  /** Source-projected bounds of action parts independently checked in the final canvas. */
  expectedActionParts?: readonly { entityId: string; name: string; rect: Rect }[]
  /** Confirmed original frame cuts that must touch the corresponding output edge. */
  expectedFrameContacts?: ReturnType<typeof wallpaperSourceFrameContacts>
  /** The positioned reference cropped background, with complete visible objects protected. */
  reviewWholeSubjects?: true
}

type Rect = WallpaperPlan['regions'][number]['rect']
type SourceObservation = Pick<WallpaperPlan, 'mode' | 'regions' | 'objectRoles'>

/** @param plan Frozen original roles and complete visible framing. @param regions Subject regions expressed in the same coordinate space. @returns The two original subjects in upper-to-lower order when they form a fully visible vertical stack. */
export function wallpaperStackedSubjects<T extends Pick<WallpaperPlan['regions'][number], 'role' | 'rect'>>(plan: Pick<WallpaperPlan, 'mode' | 'objectRoles'>, regions: readonly T[]): readonly [T, T] | undefined {
  const roles = plan.objectRoles?.filter(object => object.role !== 'supporting')
  if (plan.mode !== 'group' || roles?.length !== 2 || roles.some(object => object.role !== 'primary' || object.safetyClass !== 'general'
    || object.sourceEdges.length || object.sourceIntent?.framing !== 'whole' || object.sourceIntent.visibility !== 'visible' || object.sourceIntent.layoutFocus || object.sourceIntent.visibleAccessoryExtent)) return undefined
  const [upper, lower, extra] = regions.filter(region => region.role !== 'anchor').sort((a, b) => a.rect.y - b.rect.y)
  if (!upper || !lower || extra || upper.role !== 'subject' || lower.role !== 'subject' || upper.rect.y + upper.rect.height > lower.rect.y
    || Math.min(upper.rect.x + upper.rect.width, lower.rect.x + lower.rect.width) <= Math.max(upper.rect.x, lower.rect.x)) return undefined
  return [upper, lower]
}

/** @param rects Boxes within one coordinate space. @returns Their smallest enclosing box, if any. */
export function wallpaperEnclosingRect(rects: readonly Rect[]): Rect | undefined {
  if (!rects.length) return undefined
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y))
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x, height: Math.max(...rects.map(rect => rect.y + rect.height)) - y }
}

function subjectFillLimits(source: { width: number; height: number }, plan: SourceObservation, settings: WallpaperSettings, sourceLayout?: WallpaperSourceLayout) {
  if (sourceLayout?.alignment !== 'subject-fill-v1' || plan.mode !== 'single' && plan.mode !== 'group') return undefined
  const objects = plan.objectRoles?.filter(object => object.role !== 'supporting') ?? []
  // A clipped or unverified foreground cannot authorize removing any of the original surround.
  if (!objects.some(object => object.role === 'primary') || objects.some(({ sourceIntent, sourceEdges, rect }) =>
    sourceEdges.length > 0 || sourceIntent?.framing === 'uncertain' || sourceIntent?.visibility !== 'visible' && sourceIntent?.visibility !== 'occluded' ||
    rect.x === 0 || rect.y === 0 || rect.x + rect.width >= 1 || rect.y + rect.height >= 1)) return undefined
  const rect = wallpaperEnclosingRect([...objects.map(object => object.rect), ...plan.regions.map(region => region.rect)])
  if (!rect) return undefined
  const bounds = wallpaperProtectedBounds(settings), inset = settings.processing?.layoutInsetPixels ?? 0
  const safeScale = Math.min((settings.safe.width - 2 * inset) / (source.width * rect.width),
    (bounds.critical.bottom - bounds.top - 2 * inset) / (source.height * rect.height))
  const retain = sourceLayout.fill.minimumRetainedAxis
  const contextScale = sourceLayout.fill.relativeLayout
    ? Math.min(Math.floor(settings.width / retain) / source.width, Math.floor(settings.height / retain) / source.height)
    : Math.min(settings.width / (source.width * retain), settings.height / (source.height * retain))
  return { rect, retain, maximum: Math.min(safeScale, contextScale), preferred: Math.min(safeScale * sourceLayout.fill.safeOccupancy, contextScale) }
}

/** Use the same protected content and retained-background limits as automatic placement.
 * @param source Oriented source dimensions. @param plan Current original observation and draft.
 * @param settings Frozen output and cropping policy.
 * @returns The scale ceiling and protected group center for proportional adjustment.
 */
export function wallpaperPlacementScaleOptions(source: { width: number; height: number }, plan: SourceObservation, settings: WallpaperSettings) {
  const fit = settings.sourceIntentPolicy?.version === 'source-intent-v2' ? Math.min(settings.width / source.width, settings.height / source.height) : 1
  const fill = subjectFillLimits(source, plan, settings, settings.sourceIntentPolicy)
  const policy = settings.sourceIntentPolicy
  return fill && (fill.maximum > fit || policy?.alignment === 'subject-fill-v1' && policy.fill.relativeLayout) ? {
    maximum: fill.maximum,
    center: { x: fill.rect.x + fill.rect.width / 2, y: fill.rect.y + fill.rect.height / 2 },
  } : { maximum: fit }
}

/** Derive layout focus without changing complete source entities used for preservation review.
 * @param plan Original protected rectangles and frozen source entities.
 * @param sourceLayout Explicit source-intent policy; omission returns original rectangles unchanged.
 * @param wholeSubjects Protect the complete visible subject on a background-cropped reference.
 * @returns Layout rectangles, retaining complete automobile and indispensable-part protection.
 */
export function wallpaperLayoutRegions(plan: Pick<WallpaperPlan, 'regions' | 'objectRoles'>, sourceLayout?: WallpaperSourceLayout, wholeSubjects = false): WallpaperPlan['regions'] {
  if (!sourceLayout) return plan.regions
  return plan.regions.map(region => {
    const object = plan.objectRoles?.find(object => object.entityId === region.entityId)
    const focus = wholeSubjects ? object?.rect : object?.sourceIntent?.layoutFocus
    return region.role === 'subject' && region.safetyClass !== 'automobile' && focus ? { ...region, rect: focus } : region
  })
}

function sourceContinuationObjects(observed: Pick<WallpaperPlan, 'truncations' | 'regions' | 'objectRoles'>, settings: WallpaperSettings, sourceLayout?: WallpaperSourceLayout) {
  if (!wallpaperGenerativeRepair(settings) || !settings.sourceFrameRepair?.enabled) return []
  if (observed.objectRoles?.length) return observed.objectRoles.filter(object => !sourceLayout || object.sourceIntent?.framing === 'whole' && object.sourceIntent.visibility === 'damaged').map(object => ({ entityId: object.entityId, name: object.name, role: object.role, rect: object.rect, edges: object.sourceEdges }))
  if (sourceLayout || !observed.truncations.length) return []
  const regions = observed.regions.filter(region => region.role !== 'anchor')
  const edges = (['left', 'top', 'right', 'bottom'] as const).filter(edge => regions.some(({ rect }) => edge === 'left' ? rect.x === 0 : edge === 'top' ? rect.y === 0 : edge === 'right' ? rect.x + rect.width >= 1 : rect.y + rect.height >= 1))
  return edges.map(edge => ({ entityId: `source-${edge}`, name: `Source ${edge} edge`, role: 'primary' as const, rect: undefined, edges: [edge] }))
}

/** Locate source-frame contacts that need bounded continuation after placing a cropped object inside the canvas.
 * @param observed Source truncations and protected rectangles; background crops alone grant no subject edits.
 * @param settings Frozen generated-repair and frame-continuation authorization.
 * @param sourceLayout New tasks reserve room only for confirmed damaged main objects; omission retains historical edge handling.
 * @returns Source edges requiring layout room, or none when continuation is disabled or no authorized main object touches the frame.
 */
export function wallpaperSourceExtensionEdges(observed: Pick<WallpaperPlan, 'truncations' | 'regions' | 'objectRoles'>, settings: WallpaperSettings, sourceLayout?: WallpaperSourceLayout): ('left' | 'top' | 'right' | 'bottom')[] {
  const objects = sourceContinuationObjects(observed, settings, sourceLayout)
  return (['left', 'top', 'right', 'bottom'] as const).filter(edge => objects.some(object => (!sourceLayout || object.role !== 'supporting') && object.edges.includes(edge)))
}

type SourceEdge = 'left' | 'top' | 'right' | 'bottom'
type AdaptedSourceEdge = NonNullable<WallpaperPlan['placement']['adaptedSourceEdges']>[number]

/** A source-only planning hold preserves the limiting constraints before any image production. */
export class WallpaperFramingConflictError extends CuratorError {
  /** @param diagnostics Exact source and safety constraints that have no common placement. */
  constructor(readonly diagnostics: WallpaperFramingDiagnostics) {
    super('source-framing-conflict', 'wallpaper-layout', 'The original framing and safe area have no common placement. Inspect the source boundaries before generating an image.')
  }
}

type PlacementBound = { offset: number; fraction: number; kind: 'canvas' | 'safe' | 'frame'; edge: SourceEdge; name?: string }

/** @param plan Frozen original roles. @param sourceLayout Current source-intent policy. @returns Per-object intentional frame contacts, independent of the view label. */
export function wallpaperSourceFrameContacts(plan: Pick<WallpaperPlan, 'objectRoles'> & Partial<Pick<WallpaperPlan, 'placement'>>, sourceLayout?: WallpaperSourceLayout) {
  if (sourceLayout?.version !== 'source-intent-v2') return []
  const adapted = sourceLayout.alignment === 'subject-fill-v1' && sourceLayout.peripheralFrameAdaptation ? plan.placement?.adaptedSourceEdges : undefined
  return (plan.objectRoles ?? []).flatMap(object => object.role !== 'supporting' && object.sourceIntent?.visibility === 'frame-cropped'
    ? object.sourceEdges.filter(edge => !adapted?.some(row => row.entityId === object.entityId && row.edge === edge)).map(edge => ({ entityId: object.entityId, name: object.name, role: object.role === 'primary' ? 'subject' as const : 'critical' as const, edge }))
    : [])
}

/** @param plan Original frame contacts and previously verified adaptations. @param settings Frozen output and area thresholds. @param sourceLayout Source framing policy. @param released Contacts released by the current verified fit. @returns Conflicting frame and safe-area limits when even the best possible whole-object rectangle fails. */
export function wallpaperFrameSafetyConflict(plan: Pick<WallpaperPlan, 'objectRoles'> & Partial<Pick<WallpaperPlan, 'placement'>>, settings: WallpaperSettings, sourceLayout?: WallpaperSourceLayout, released: readonly SourceEdge[] = []): WallpaperFramingDiagnostics | undefined {
  const policy = wallpaperPracticalAcceptance(settings)
  if (policy?.version !== 'practical-v2' || sourceLayout?.alignment !== 'subject-fill-v1' || !sourceLayout.wholeSubjectSafety) return
  const contacts = wallpaperSourceFrameContacts(plan, sourceLayout).filter(contact => !released.includes(contact.edge))
  const bounds = wallpaperProtectedBounds(settings)
  for (const object of plan.objectRoles ?? []) {
    const edges = contacts.filter(contact => contact.entityId === object.entityId).map(contact => contact.edge)
    if (!edges.length) continue
    const safeWidth = bounds.critical.right - bounds.critical.left, safeHeight = bounds.critical.bottom - bounds.top
    const horizontal = safeWidth / (safeWidth + (edges.includes('left') ? bounds.critical.left : 0) + (edges.includes('right') ? settings.width - bounds.critical.right : 0))
    const vertical = safeHeight / (safeHeight + (edges.includes('top') ? bounds.top : 0) + (edges.includes('bottom') ? settings.height - bounds.critical.bottom : 0))
    if (horizontal * vertical >= (object.role === 'primary' && object.safetyClass !== 'automobile' ? policy.minimumCoreInsideRatio : 1)) continue
    return { version: 'source-framing-conflict-v1', edges, minimumScale: 0, limits: edges.slice(0, 3).map(edge => ({
      axis: edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical', kind: 'offset',
      lower: { kind: 'frame', edge, name: object.name }, upper: { kind: 'safe', edge, name: object.name },
    })) }
  }
}

function sourceFrameContacts(plan: Pick<WallpaperPlan, 'objectRoles'> & Partial<Pick<WallpaperPlan, 'placement'>>, sourceLayout?: WallpaperSourceLayout): SourceEdge[] {
  return [...new Set(wallpaperSourceFrameContacts(plan, sourceLayout).map(contact => contact.edge))]
}

function sourceAccessory(object: WallpaperObjectRole) {
  return object.role === 'primary' && object.safetyClass === 'general' ? object.sourceIntent?.visibleAccessoryExtent : undefined
}

function sourceCanvasBounds(object: WallpaperObjectRole) {
  const { rect } = object
  const accessory = sourceAccessory(object)
  return {
    left: accessory ? Math.min(rect.x, accessory.x) : rect.x,
    top: accessory ? Math.min(rect.y, accessory.y) : rect.y,
    right: accessory ? Math.max(rect.x + rect.width, accessory.x + accessory.width) : rect.x + rect.width,
    bottom: accessory ? Math.max(rect.y + rect.height, accessory.y + accessory.height) : rect.y + rect.height,
  }
}

function frameBackgroundTrim(plan: SourceObservation, sourceLayout?: WallpaperSourceLayout) {
  if (sourceLayout?.alignment !== 'subject-fill-v1' || !sourceLayout.fill.relativeLayout || plan.mode !== 'single' && plan.mode !== 'group') return undefined
  const contacts = sourceFrameContacts(plan, sourceLayout)
  const edge = contacts[0]
  if (!edge || contacts.length !== 1 || plan.objectRoles?.some(object => object.role !== 'supporting' &&
    (object.sourceIntent?.framing === 'uncertain' || !object.sourceIntent ||
      (object.sourceIntent.visibility === 'frame-cropped' ? object.sourceEdges.length === 0 : object.sourceEdges.length > 0 || object.sourceIntent.visibility !== 'visible' && object.sourceIntent.visibility !== 'occluded')))) return undefined
  return { edge, retain: sourceLayout.fill.minimumRetainedAxis }
}

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
 * @param sourceLayout Explicit new-task edit permission; omission retains historical continuation targets.
 * @returns Per-object contacts, including final-frame crops that must not be reconstructed inside the source.
 */
export function wallpaperSourceContinuationTargets(plan: WallpaperPlan, settings: WallpaperSettings, source: { width: number; height: number }, sourceLayout?: WallpaperSourceLayout): WallpaperSourceContinuationTarget[] {
  const objects = sourceContinuationObjects(plan, settings, sourceLayout)
  if (!objects.length) return []
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
  return objects.flatMap(object => object.edges.map(edge => ({
    entityId: object.entityId, name: object.name, edge, disposition: inside(edge, object.rect) ? 'interior' as const : 'final-frame-crop' as const,
    ...(object.rect ? { rect: object.rect } : {}),
  })))
}

/** @param plan Frozen placement. @param settings Output policy. @param source Reference dimensions. @param sourceLayout New-task edit permission; omission keeps historical targets. @returns Model-visible per-object edit permission without treating final-frame crops as interior defects. */
export function wallpaperSourceContinuationContext(plan: WallpaperPlan, settings: WallpaperSettings, source: { width: number; height: number }, sourceLayout?: WallpaperSourceLayout) {
  return { targets: wallpaperSourceContinuationTargets(plan, settings, source, sourceLayout), marginPixels: settings.sourceFrameRepair?.marginPixels ?? 0,
    ...(plan.placement.adaptedSourceEdges ? { adaptedSourceEdges: plan.placement.adaptedSourceEdges } : {}) }
}

/** Map each internal source cut to a full-output crop for the independent native review.
 * @param plan Frozen placement and source object rectangles. @param settings Output frame. @param source Oriented source dimensions.
 * @param sourceLayout New-task edit permission; omission retains historical review regions.
 * @returns Local views including generated pixels beyond the old cut and the adjacent source object.
 */
export function wallpaperSourceContinuationReviewRegions(plan: WallpaperPlan, settings: WallpaperSettings, source: { width: number; height: number }, sourceLayout?: WallpaperSourceLayout) {
  const width = Math.round(source.width * plan.placement.scale), height = Math.round(source.height * plan.placement.scale)
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  return wallpaperSourceContinuationTargets(plan, settings, source, sourceLayout).filter(target => target.disposition === 'interior' && target.rect).map(target => {
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
 * @param sourceLayout New-task focus and size policy; omission retains historical candidate geometry.
 * @returns Uniform candidate placement for layout or clock-background defects, or absence when subject, structure or image quality still needs repair.
 */
export function wallpaperCandidatePlacement(prior: Pick<WallpaperItem['attempts'][number], 'plan' | 'review' | 'outputId' | 'compositionMode'>, settings: WallpaperSettings, sourceLayout?: WallpaperSourceLayout): WallpaperPlan | undefined {
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
  const observed = { ...prior.plan, imageVersionId: prior.outputId, mode: 'group' as const, evidence: review.sourceCorrespondence.reason, regions, objectRoles: prior.plan.objectRoles?.map(object => {
    const actual = sourceLayout && object.role !== 'supporting' ? review.actualLayout.regions.find(region => region.entityId === object.entityId && region.scope === 'core' && region.role === (object.role === 'primary' ? 'subject' : 'critical')) : undefined
    return { ...object, ...(actual ? { rect: actual.rect, ...(object.sourceIntent ? { sourceIntent: { ...object.sourceIntent, layoutFocus: actual.layoutFocus } } : {}) } : {}), sourceEdges: [] }
  }), truncations: [], uncertainties: [],
    editPrompt: `保持已保存完整候选的对象、结构、取景、纹理和内部相对位置。按本轮参考画布提供的等比缩放定位要求，${review.checks.background.result === 'violated' ? '保护已验收主体和必要结构，仅修复已定位的背景缺陷并补全新露出的背景' : '只补新露出的外围背景'}${settings.processing?.clockContrast ? '，并按显式时钟规则改善顶部白色时间背景对比' : ''}；不要把中间画面放大铺满，不重画主体。`,
    reason: 'Uniform placement derived from independently reviewed candidate regions; subject and image quality remain subject to final review.' }
  const placement = layoutDefect ? fitWallpaperPlacement(settings, observed, settings, 'subject-first-v2', [], sourceLayout) : { scale: 1, left: 0, top: 0 }
  if (layoutDefect && placement.scale === 1 && placement.left === 0 && placement.top === 0) return undefined
  const plan = { ...observed, placement }
  return wallpaperGeometry(settings, plan, settings, sourceLayout).checks.length ? undefined : plan
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
 * @returns Blocking excess, nonblocking warnings and the eligible edge for remeasurement when applicable. A remeasurement candidate still fails the current estimate. Strict policy has no result.
 */
export function wallpaperPracticalRegionBoundary(region: Pick<WallpaperPlan['regions'][number], 'name' | 'role' | 'safetyClass'> & { left: number; top: number; width: number; height: number }, settings: WallpaperSettings): { hard: string[]; warnings: string[]; borderline?: { edge: SourceEdge; overflowPixels: number; insideRatio: number } } | undefined {
  const policy = wallpaperPracticalAcceptance(settings)
  if (!policy) return undefined
  const bounds = wallpaperProtectedBounds(settings), tolerance = policy.version === 'practical-v1' ? policy.coordinateTolerancePixels : 0
  const right = region.left + region.width, bottom = region.top + region.height
  const overflow = { left: Math.max(0, bounds.critical.left - region.left), top: Math.max(0, bounds.top - region.top), right: Math.max(0, right - bounds.critical.right), bottom: Math.max(0, bottom - bounds.critical.bottom) }
  // Converting normalized edges back to pixels and adding their extents can leave a few floating-point units on an exact line.
  const precision = policy.version === 'practical-v2' ? Number.EPSILON * Math.max(settings.width, settings.height) * 4 : 0
  const overflowingEdges = (['left', 'right', 'top', 'bottom'] as const).filter(edge => overflow[edge] > precision)
  const clipTolerance = tolerance + precision
  const hard: string[] = [], warnings: string[] = []
  if (region.left < -clipTolerance || region.top < -clipTolerance || right > settings.width + clipTolerance || bottom > settings.height + clipTolerance) hard.push(`clipped:${region.name}`)
  if (policy.version === 'practical-v2' && region.safetyClass === 'automobile') {
    if (overflowingEdges.length) hard.push(`automobile-outside:${region.name}`)
  } else if (region.role !== 'subject') {
    if (overflowingEdges.some(edge => overflow[edge] > clipTolerance)) hard.push(`critical-outside:${region.name}`)
  } else {
    const insideWidth = Math.max(0, Math.min(right, bounds.critical.right + tolerance) - Math.max(region.left, bounds.critical.left - tolerance))
    const insideHeight = Math.max(0, Math.min(bottom, bounds.critical.bottom + tolerance) - Math.max(region.top, bounds.top - tolerance))
    const insideRatio = insideWidth * insideHeight / (region.width * region.height)
    const edgeRatio = Math.max(Math.max(0, overflow.left - tolerance) / region.width, Math.max(0, overflow.right - tolerance) / region.width, Math.max(0, overflow.top - tolerance) / region.height, Math.max(0, overflow.bottom - tolerance) / region.height)
    if (insideRatio < policy.minimumCoreInsideRatio || policy.version === 'practical-v1' && edgeRatio > policy.maximumCoreEdgeOverflowRatio) {
      hard.push(`subject-overflow:${region.name}`)
      const recheck = policy.version === 'practical-v2' && policy.nearBoundaryRecheck
      const [edge] = overflowingEdges
      if (recheck && region.safetyClass === 'general' && hard.length === 1 && edge && overflowingEdges.length === 1 && insideRatio >= recheck.minimumInsideRatio) {
        const span = edge === 'left' || edge === 'right' ? settings.safe.width : bounds.critical.bottom - bounds.top
        const limit = Math.min(span * recheck.maximumSafeAxisRatio, Math.min(settings.width, settings.height) * recheck.maximumOutputShortSideRatio)
        if (overflow[edge] <= limit) return { hard, warnings, borderline: { edge, overflowPixels: overflow[edge], insideRatio } }
      }
    }
  }
  if (!hard.length && overflowingEdges.length) warnings.push(`core-outside:${region.name}`)
  return { hard, warnings }
}

/** Describe only positioned output regions; frozen object identities do not carry source rectangles into output coordinates.
 * @param plan Effective original or complete-candidate placement. @param source Effective reference dimensions. @param settings Frozen output geometry.
 * @param sourceLayout New-task focus policy; omission positions complete historical rectangles.
 * @returns Output-normalized protection regions and semantic object roles, with the applied source transform explicitly identified.
 */
export function wallpaperPositionedLayout(plan: WallpaperPlan, source: { width: number; height: number }, settings: WallpaperSettings, sourceLayout?: WallpaperSourceLayout) {
  const geometry = wallpaperGeometry(source, wallpaperModelPlan(plan), settings, sourceLayout)
  return { ...wallpaperLayoutCoordinates(settings), sourceImageVersionId: plan.imageVersionId, referenceTransformAlreadyApplied: true,
    ...(geometry.backgroundCrop ? { backgroundCrop: true as const } : {}),
    appliedSourceTransform: plan.placement,
    positionedRegions: geometry.regions.map(region => ({ name: region.name, entityId: region.entityId, role: region.role, ...(region.safetyClass ? { safetyClass: region.safetyClass } : {}),
      rect: { x: region.left / settings.width, y: region.top / settings.height, width: region.width / settings.width, height: region.height / settings.height } })),
    objectRoles: plan.objectRoles?.map(({ entityId, name, role, safetyClass }) => ({ entityId, name, role, ...(safetyClass ? { safetyClass } : {}) })) }
}

/** Fit all inferred protected regions with the same rounded source geometry used by rendering.
 * @param source Oriented original dimensions. @param observed Model observations without pixel placement. @param settings Frozen safe area and output size. @param policy V2 centers protected objects; V3 minimizes new pixels for a full-size healthy source.
 * @param extensionEdges Confirmed source edges requiring new pixels; omission reserves no additional space.
 * @param sourceLayout New-task focus and edge authorization; omission preserves historical fitting.
 * @param adaptations Peripheral original contacts verified with local pixels. Only used for generated-canvas framing recovery.
 * @returns V2 references retain intentional frame contacts and prefer the configured subject center before scale; historical layouts never enlarge the original.
 */
export function fitWallpaperPlacement(source: { width: number; height: number }, observed: Omit<WallpaperPlan, 'placement'>, settings: WallpaperSettings, policy: 'crop-first-v1' | 'subject-first-v2' | 'source-preserving-v3' = 'crop-first-v1', extensionEdges: readonly SourceEdge[] = [], sourceLayout?: WallpaperSourceLayout, adaptations?: readonly AdaptedSourceEdge[]): WallpaperPlan['placement'] {
  const inset = settings.processing?.layoutInsetPixels ?? 0
  const accessoryMargin = sourceLayout && observed.objectRoles?.some(sourceAccessory) ? settings.sourceFrameRepair?.marginPixels ?? 0 : 0
  const fitBounds = (padding: number, trim?: ReturnType<typeof frameBackgroundTrim>, released?: readonly SourceEdge[]) => {
    if (accessoryMargin > 0) {
      try { return fitWallpaperPlacementBounds(source, observed, settings, policy, extensionEdges, sourceLayout, padding, trim, released, accessoryMargin) }
      catch (error) { if (!(error instanceof WallpaperFramingConflictError)) throw error }
    }
    return fitWallpaperPlacementBounds(source, observed, settings, policy, extensionEdges, sourceLayout, padding, trim, released)
  }
  try {
    return fitBounds(inset)
  } catch (error) {
    if (!(error instanceof WallpaperFramingConflictError)) throw error
    const trim = frameBackgroundTrim(observed, sourceLayout)
    const fit = (trim?: ReturnType<typeof frameBackgroundTrim>, released?: readonly SourceEdge[]) => {
      let lower = 0, upper = inset, placement: WallpaperPlan['placement'] | undefined
      // Keep the greatest feasible planning inset; the actual safe-area limits still apply at zero inset.
      while (lower <= upper) {
        const padding = Math.floor((lower + upper) / 2)
        try {
          placement = fitBounds(padding, trim, released)
          lower = padding + 1
        } catch (failure) {
          if (!(failure instanceof WallpaperFramingConflictError)) throw failure
          upper = padding - 1
        }
      }
      return placement
    }
    const backgroundTrim = trim && fit(trim)
    if (backgroundTrim) return backgroundTrim
    if (sourceLayout?.alignment !== 'subject-fill-v1' || !sourceLayout.peripheralFrameAdaptation || !adaptations) throw error
    const preserved = fit()
    if (preserved) return preserved
    const contacts = wallpaperSourceFrameContacts(observed, sourceLayout)
    const releasable = [...new Set(adaptations.map(row => row.edge))].filter(edge =>
      contacts.filter(contact => contact.edge === edge).every(contact => adaptations.some(row => row.entityId === contact.entityId && row.edge === edge)))
    // There are only four frame edges. Prefer preserving every independently feasible original contact.
    const possibilities = releasable.reduce<SourceEdge[][]>((sets, edge) => [...sets, ...sets.map(set => [...set, edge])], [[]])
    for (const released of possibilities.slice(1).sort((first, second) => first.length - second.length)) {
      const placement = fit(undefined, released)
      if (placement) return { ...placement, adaptedSourceEdges: adaptations.filter(row => released.includes(row.edge)) }
    }
    throw error
  }
}

function fitWallpaperPlacementBounds(source: { width: number; height: number }, observed: Omit<WallpaperPlan, 'placement'>, settings: WallpaperSettings, policy: 'crop-first-v1' | 'subject-first-v2' | 'source-preserving-v3', extensionEdges: readonly SourceEdge[], sourceLayout: WallpaperSourceLayout | undefined, inset: number, trim?: NonNullable<ReturnType<typeof frameBackgroundTrim>>, released: readonly SourceEdge[] = [], accessoryMargin = 0): WallpaperPlan['placement'] {
  const bounds = wallpaperProtectedBounds(settings)
  const conflict = wallpaperFrameSafetyConflict(observed, settings, sourceLayout, released)
  if (conflict) throw new WallpaperFramingConflictError(conflict)
  const margin = settings.sourceFrameRepair?.marginPixels ?? 0
  const allowedEdges = wallpaperSourceExtensionEdges(observed, settings, sourceLayout)
  const edges = extensionEdges.length ? sourceLayout ? extensionEdges.filter(edge => allowedEdges.includes(edge)) : extensionEdges : allowedEdges
  const fillLimits = subjectFillLimits(source, observed, settings, sourceLayout)
  const fill = fillLimits && fillLimits.preferred > Math.min(settings.width / source.width, settings.height / source.height) ? fillLimits : undefined
  const layoutRegions = wallpaperLayoutRegions(observed, sourceLayout, !!fill)
  const visibleObjects = sourceLayout ? observed.objectRoles?.filter(object => object.role !== 'supporting') ?? [] : []
  const frameContacts = sourceFrameContacts(observed, sourceLayout).filter(edge => !released.includes(edge))
  const centered = sourceLayout?.alignment !== undefined && (observed.mode === 'single' || observed.mode === 'group')
  const relativeLayout = sourceLayout?.alignment === 'subject-fill-v1' && sourceLayout.fill.relativeLayout
  const joined = fill?.rect ?? (centered && relativeLayout && !frameContacts.length && visibleObjects.length && visibleObjects.every(object =>
    object.sourceIntent?.visibility === 'visible' || object.sourceIntent?.visibility === 'occluded')
    ? wallpaperEnclosingRect([...visibleObjects.map(object => object.rect), ...observed.regions.map(region => region.rect)]) : undefined)
  const primaries = visibleObjects.filter(object => object.role === 'primary')
  const partials = primaries.filter(object => object.sourceIntent?.layoutFocus)
  const leads = partials.length ? partials : primaries
  const sourceCenterX = joined ? joined.x + joined.width / 2 : centered ? (Math.min(...leads.map(object => object.rect.x)) + Math.max(...leads.map(object => object.rect.x + object.rect.width))) / 2 : 0.5
  const focus = joined ? [joined] : centered ? leads.map(object => object.sourceIntent?.visibility === 'frame-cropped' ? object.sourceIntent.layoutFocus ?? object.rect : object.rect) : layoutRegions.filter(region => region.role === 'subject').map(region => region.rect)
  const sourceCenterY = focus.length ? (Math.min(...focus.map(rect => rect.y)) + Math.max(...focus.map(rect => rect.y + rect.height))) / 2 : 0.5
  const centerX = settings.safe.left + settings.safe.width / 2, centerY = (bounds.top + bounds.critical.bottom) / 2
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)))
  const horizontal: { lower: PlacementBound[]; upper: PlacementBound[] } = { lower: [{ offset: 1, fraction: -1, kind: 'canvas', edge: 'right' }], upper: [{ offset: settings.width - 1, fraction: 0, kind: 'canvas', edge: 'left' }] }
  const vertical: { lower: PlacementBound[]; upper: PlacementBound[] } = { lower: [{ offset: 1, fraction: -1, kind: 'canvas', edge: 'bottom' }], upper: [{ offset: settings.height - 1, fraction: 0, kind: 'canvas', edge: 'top' }] }
  const protectedRegions = joined ? [{ name: 'Protected content', role: 'critical' as const, rect: joined }] : layoutRegions
  for (const region of protectedRegions) {
    const base = wallpaperPracticalAcceptance(settings) || region.role !== 'subject' ? bounds.critical : bounds.subject
    horizontal.lower.push({ offset: Math.max(0, base.left + inset + (edges.includes('left') ? margin : 0)), fraction: -region.rect.x, kind: 'safe', edge: 'left', name: region.name })
    horizontal.upper.push({ offset: Math.min(settings.width, base.right - inset - (edges.includes('right') ? margin : 0)), fraction: -(region.rect.x + region.rect.width), kind: 'safe', edge: 'right', name: region.name })
    vertical.lower.push({ offset: bounds.top + inset + (edges.includes('top') ? margin : 0), fraction: -region.rect.y, kind: 'safe', edge: 'top', name: region.name })
    vertical.upper.push({ offset: Math.min(settings.height, base.bottom - inset - (edges.includes('bottom') ? margin : 0)), fraction: -(region.rect.y + region.rect.height), kind: 'safe', edge: 'bottom', name: region.name })
  }
  for (const object of visibleObjects) {
    const canvas = sourceCanvasBounds(object)
    // Only an attachment's protruding sides benefit from measurement slack at the outer frame.
    horizontal.lower.push({ offset: canvas.left < object.rect.x ? accessoryMargin : 0, fraction: -canvas.left, kind: 'canvas', edge: 'left', name: object.name })
    horizontal.upper.push({ offset: settings.width - (canvas.right > object.rect.x + object.rect.width ? accessoryMargin : 0), fraction: -canvas.right, kind: 'canvas', edge: 'right', name: object.name })
    vertical.lower.push({ offset: canvas.top < object.rect.y ? accessoryMargin : 0, fraction: -canvas.top, kind: 'canvas', edge: 'top', name: object.name })
    vertical.upper.push({ offset: settings.height - (canvas.bottom > object.rect.y + object.rect.height ? accessoryMargin : 0), fraction: -canvas.bottom, kind: 'canvas', edge: 'bottom', name: object.name })
  }
  if (fill) {
    horizontal.lower.push({ offset: 0, fraction: fill.retain - 1, kind: 'canvas', edge: 'left' }); horizontal.upper.push({ offset: settings.width, fraction: -fill.retain, kind: 'canvas', edge: 'right' })
    vertical.lower.push({ offset: 0, fraction: fill.retain - 1, kind: 'canvas', edge: 'top' }); vertical.upper.push({ offset: settings.height, fraction: -fill.retain, kind: 'canvas', edge: 'bottom' })
  } else if (trim) {
    const horizontalTrim = trim.edge === 'left' || trim.edge === 'right'
    const axis = horizontalTrim ? horizontal : vertical, perpendicular = horizontalTrim ? vertical : horizontal
    const extent = horizontalTrim ? settings.width : settings.height
    const leading = horizontalTrim ? 'left' : 'top', trailing = horizontalTrim ? 'right' : 'bottom'
    perpendicular.lower.push({ offset: 0, fraction: 0, kind: 'canvas', edge: horizontalTrim ? 'top' : 'left' })
    perpendicular.upper.push({ offset: horizontalTrim ? settings.height : settings.width, fraction: -1, kind: 'canvas', edge: horizontalTrim ? 'bottom' : 'right' })
    if (trim.edge === leading) {
      axis.lower.push({ offset: extent + 1, fraction: -1, kind: 'canvas', edge: trailing })
      axis.upper.push({ offset: extent, fraction: -trim.retain, kind: 'canvas', edge: trailing })
    } else {
      axis.lower.push({ offset: 0, fraction: trim.retain - 1, kind: 'canvas', edge: leading })
      axis.upper.push({ offset: -1, fraction: 0, kind: 'canvas', edge: leading })
    }
  } else if (sourceLayout?.version === 'source-intent-v2') {
    horizontal.lower.push({ offset: 0, fraction: 0, kind: 'canvas', edge: 'left' }); horizontal.upper.push({ offset: settings.width, fraction: -1, kind: 'canvas', edge: 'right' })
    vertical.lower.push({ offset: 0, fraction: 0, kind: 'canvas', edge: 'top' }); vertical.upper.push({ offset: settings.height, fraction: -1, kind: 'canvas', edge: 'bottom' })
  }
  for (const edge of frameContacts) {
    const axis = edge === 'left' || edge === 'right' ? horizontal : vertical
    const constraint: PlacementBound = edge === 'left' || edge === 'top' ? { offset: 0, fraction: 0, kind: 'frame', edge } : { offset: edge === 'right' ? settings.width : settings.height, fraction: -1, kind: 'frame', edge }
    axis.lower.push(constraint); axis.upper.push(constraint)
  }
  const intervals = (scale: number) => {
    const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale))
    const keep = fill ?? trim
    const retainedWidth = keep && relativeLayout ? retainedPixels(width, keep.retain) : 0
    const retainedHeight = keep && relativeLayout ? retainedPixels(height, keep.retain) : 0
    const left = Math.max(retainedWidth - width, ...horizontal.lower.map(bound => Math.ceil(bound.offset + bound.fraction * width)))
    const right = Math.min(settings.width - retainedWidth, ...horizontal.upper.map(bound => Math.floor(bound.offset + bound.fraction * width)))
    const top = Math.max(retainedHeight - height, ...vertical.lower.map(bound => Math.ceil(bound.offset + bound.fraction * height)))
    const bottom = Math.min(settings.height - retainedHeight, ...vertical.upper.map(bound => Math.floor(bound.offset + bound.fraction * height)))
    return { width, height, left, right, top, bottom, feasible: left <= right && top <= bottom && retainedWidth <= settings.width && retainedHeight <= settings.height }
  }
  const cropScale = Math.min(1, Math.max(settings.width / source.width, settings.height / source.height))
  const crop = intervals(cropScale)
  const canCrop = crop.feasible && crop.width >= settings.width && crop.height >= settings.height && Math.max(crop.left, settings.width - crop.width) <= Math.min(crop.right, 0) && Math.max(crop.top, settings.height - crop.height) <= Math.min(crop.bottom, 0)
  let scale = policy !== 'crop-first-v1' && (observed.mode === 'single' || observed.mode === 'group') && !canCrop ? 1 : cropScale, limits = intervals(scale)
  const sceneContacts = observed.mode === 'scene' ? sourceFrameContacts({ objectRoles: primaries }, sourceLayout) : []
  const fixedSceneExtent = sceneContacts.includes('left') && sceneContacts.includes('right') || sceneContacts.includes('top') && sceneContacts.includes('bottom')
  if (sourceLayout?.version === 'source-intent-v2' && (observed.mode === 'single' || observed.mode === 'group' || fixedSceneExtent)) {
    let minimum = 0, maximum = Infinity
    let minimumLimit: WallpaperFramingDiagnostics['limits'][number] | undefined, maximumLimit: WallpaperFramingDiagnostics['limits'][number] | undefined
    const describe = ({ kind, edge, name }: PlacementBound) => ({ kind, edge, ...(name ? { name } : {}) })
    const conflict = (limit?: WallpaperFramingDiagnostics['limits'][number]): never => { throw new WallpaperFramingConflictError({ version: 'source-framing-conflict-v1', edges: frameContacts, minimumScale: minimum, ...(Number.isFinite(maximum) ? { maximumScale: maximum } : {}), limits: [minimumLimit, maximumLimit, limit].filter((row): row is NonNullable<typeof row> => row !== undefined) }) }
    for (const [axis, length] of [[horizontal, source.width], [vertical, source.height]] as const) for (const lower of axis.lower) for (const upper of axis.upper) {
      const slope = (lower.fraction - upper.fraction) * length, offset = upper.offset - lower.offset
      const pair = { axis: axis === horizontal ? 'horizontal' as const : 'vertical' as const, lower: describe(lower), upper: describe(upper) }
      if (slope > 0 && offset / slope < maximum) { maximum = offset / slope; maximumLimit = { ...pair, kind: 'maximum', scale: maximum } }
      else if (slope < 0 && offset / slope > minimum) { minimum = offset / slope; minimumLimit = { ...pair, kind: 'minimum', scale: minimum } }
      else if (slope === 0 && offset < 0) conflict({ ...pair, kind: 'offset' })
    }
    if (maximum <= 0 || maximum < minimum) conflict()
    scale = Math.min(maximum, fill?.preferred ?? maximum); limits = intervals(scale)
    // Descending raster transitions resolve integer rounding without assuming anchored layouts fit at zero scale.
    while (!limits.feasible && scale >= minimum) {
      const next = Math.max(limits.width > 1 ? (limits.width - 0.5) / source.width : 0, limits.height > 1 ? (limits.height - 0.5) / source.height : 0)
      if (next === 0) conflict()
      // Division and multiplication can each round back to an exact half pixel.
      const nextScale = Math.min(scale, next) * (1 - 2 * Number.EPSILON)
      const nextLimits = intervals(nextScale)
      if (nextScale >= scale || nextLimits.width === limits.width && nextLimits.height === limits.height) conflict()
      scale = nextScale; limits = nextLimits
    }
    if (scale < minimum) conflict()
    if (centered) {
      const distance = (candidate: number) => {
        const box = intervals(candidate)
        if (!box.feasible) return Infinity
        const x = clamp(centerX - sourceCenterX * box.width, box.left, box.right) + sourceCenterX * box.width
        const y = clamp(centerY - sourceCenterY * box.height, box.top, box.bottom) + sourceCenterY * box.height
        // Half-pixel center differences are raster rounding; equal centers retain the larger subject.
        return (Math.max(0, Math.abs(x - centerX) - 0.5) / settings.safe.width) ** 2 + (Math.max(0, Math.abs(y - centerY) - 0.5) / settings.safe.height) ** 2
      }
      let lower = minimum, upper = scale
      for (let i = 0; i < 40; i++) {
        const first = lower + (upper - lower) / 3, second = upper - (upper - lower) / 3
        if (distance(first) < distance(second)) upper = second
        else lower = first
      }
      scale = [lower, upper, (lower + upper) / 2].reduce((best, candidate) => distance(candidate) < distance(best) || distance(candidate) === distance(best) && candidate > best ? candidate : best, scale)
      limits = intervals(scale)
    }
  } else if (!limits.feasible) {
    let lower = 0, upper = scale
    // Rounded dimensions make feasibility monotonic; the final interval is checked again by wallpaperGeometry.
    for (let i = 0; i < 40; i++) { const middle = (lower + upper) / 2; if (intervals(middle).feasible) lower = middle; else upper = middle }
    scale = lower; limits = intervals(scale)
  }
  if (!scale || !limits.feasible) throw new CuratorError('constraint-conflict', 'wallpaper-layout', 'The protected regions cannot fit the frozen safe area.')
  const cropLeft = Math.max(limits.left, settings.width - limits.width), cropRight = Math.min(limits.right, 0)
  const cropTop = Math.max(limits.top, settings.height - limits.height), cropBottom = Math.min(limits.bottom, 0)
  if (!centered && limits.width >= settings.width && limits.height >= settings.height && cropLeft <= cropRight && cropTop <= cropBottom) return { scale, left: clamp((settings.width - limits.width) / 2, cropLeft, cropRight), top: clamp((settings.height - limits.height) / 2, cropTop, cropBottom) }
  if (policy === 'source-preserving-v3' && source.width === settings.width && source.height === settings.height && scale === 1) return { scale, left: clamp(0, limits.left, limits.right), top: clamp(0, limits.top, limits.bottom) }
  const verticalFocus = focus.length ? sourceCenterY : layoutRegions.length ? (Math.min(...layoutRegions.map(region => region.rect.y)) + Math.max(...layoutRegions.map(region => region.rect.y + region.rect.height))) / 2 : 0.5
  return { scale, left: clamp(centered ? centerX - sourceCenterX * limits.width : (settings.width - limits.width) / 2, limits.left, limits.right), top: clamp(centerY - verticalFocus * limits.height, limits.top, limits.bottom) }
}

function retainedPixels(extent: number, ratio: number): number { return Math.ceil(extent * ratio) }

/** Measure the source transform and check the model's inferred regions.
 * @param source Oriented source dimensions.
 * @param plan Saved inferred layout.
 * @param settings Frozen output template.
 * @param sourceLayout New-task focus and per-subject output targets; omission retains the historical aggregate-size gate.
 * @param subjectMeasurements Comparable focus rectangles in the source coordinate space when containment uses complete visible rectangles.
 * @returns Measured canvas intersection, transformed regions and constraint failures.
 */
export function wallpaperGeometry(source: { width: number; height: number }, plan: WallpaperPlan, settings: WallpaperSettings, sourceLayout?: WallpaperSourceLayout, subjectMeasurements?: WallpaperPlan['regions']) {
  const width = Math.max(1, Math.round(source.width * plan.placement.scale)), height = Math.max(1, Math.round(source.height * plan.placement.scale))
  const { left, top } = plan.placement, bounds = wallpaperProtectedBounds(settings)
  const target = { left: Math.max(0, left), top: Math.max(0, top), width: Math.min(settings.width, left + width) - Math.max(0, left), height: Math.min(settings.height, top + height) - Math.max(0, top) }
  if (target.width <= 0 || target.height <= 0) throw new CuratorError('invalid-input', 'wallpaper-layout', 'The source does not intersect the output canvas.')
  const cropped = sourceLayout?.alignment === 'subject-fill-v1' && (plan.mode === 'single' || plan.mode === 'group') && (target.width < width || target.height < height)
  const fill = cropped ? subjectFillLimits(source, plan, settings, sourceLayout) : undefined
  const contacts = { left, top, right: left + width - settings.width, bottom: top + height - settings.height }
  const trim = cropped && !fill ? frameBackgroundTrim(plan, sourceLayout) : undefined
  const oneSideTrim = trim && contacts[trim.edge] === 0 &&
    (trim.edge === 'left' || trim.edge === 'right' ? height === target.height : width === target.width)
  const layoutRegions = wallpaperLayoutRegions(plan, sourceLayout, !!fill)
  const regions = layoutRegions.map(region => ({ ...region, left: left + region.rect.x * width, top: top + region.rect.y * height, width: region.rect.width * width, height: region.rect.height * height }))
  const checks: string[] = [], warnings: string[] = []
  if (cropped && !fill && !oneSideTrim) checks.push('source-background-crop-unavailable')
  if (oneSideTrim && (target.width < retainedPixels(width, trim.retain) || target.height < retainedPixels(height, trim.retain))) checks.push('source-background-context')
  if (fill) {
    if (target.width < retainedPixels(width, fill.retain) || target.height < retainedPixels(height, fill.retain)) checks.push('source-background-context')
    const { rect } = fill
    if (left + rect.x * width < bounds.critical.left || left + (rect.x + rect.width) * width > bounds.critical.right ||
        top + rect.y * height < bounds.top || top + (rect.y + rect.height) * height > bounds.critical.bottom) checks.push('source-crop-protected-outside')
  }
  if (plan.placement.scale > 1 && sourceLayout?.version !== 'source-intent-v2') checks.push('source-upscale-not-enabled')
  for (const edge of sourceFrameContacts(plan, sourceLayout)) if (contacts[edge] !== 0) checks.push(`source-framing:${edge}`)
  if (sourceLayout) for (const object of plan.objectRoles?.filter(object => object.role !== 'supporting') ?? []) {
    const canvas = sourceCanvasBounds(object)
    if (left + canvas.left * width < 0 || top + canvas.top * height < 0 || left + canvas.right * width > settings.width || top + canvas.bottom * height > settings.height) checks.push(`source-clipped:${object.name}`)
  }
  if (plan.mode === 'uncertain' || plan.uncertainties.length && !wallpaperGenerativeRepair(settings) || !regions.length && (plan.mode === 'single' || plan.mode === 'group')) checks.push('uncertain-subject')
  const acceptance = wallpaperPracticalAcceptance(settings)
  if ((plan.mode === 'single' || plan.mode === 'group') && (!regions.some(region => region.role === 'subject') || !acceptance && !regions.some(region => region.role === 'critical'))) checks.push('missing-protected-regions')
  if (sourceLayout?.expectedSubjects) {
    const expansion = wallpaperExpansionReview(settings)
    for (const expected of sourceLayout.expectedSubjects) {
      const actual = (subjectMeasurements ?? layoutRegions).find(region => region.role === 'subject' && region.entityId === expected.entityId)
      if (!actual) checks.push(`missing-subject-layout:${expected.entityId}`)
      else {
        const target = expected.focus ?? expected.rect
        const actualWidth = actual.rect.width * width, actualHeight = actual.rect.height * height
        const expectedSpan = Math.max(target.width * settings.width, target.height * settings.height)
        const retainedScale = sourceLayout.version === 'source-intent-v2'
          ? Math.max(actualWidth, actualHeight) / expectedSpan
          : Math.min(actualWidth / (target.width * settings.width), actualHeight / (target.height * settings.height))
        if (retainedScale < sourceLayout.minimumSubjectScaleRatio) {
          const measurementAllowance = expansion?.version === 'expansion-first-v2' && sourceLayout.version === 'source-intent-v2'
            ? (settings.processing?.layoutInsetPixels ?? 0) / expectedSpan : 0
          const results = expansion && retainedScale + measurementAllowance >= expansion.minimumPlannedScaleRatio ? warnings : checks
          results.push(`subject-too-small:${actual.name}`)
        }
      }
    }
  } else if (!sourceLayout && acceptance && (plan.mode === 'single' || plan.mode === 'group')) {
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
  return { width, height, left, top, target, regions, backgroundCrop: !!(fill || oneSideTrim), reviewWholeSubjects: !!fill, checks: [...new Set(checks)], warnings: [...new Set(warnings)], needsOutpaint: target.width * target.height < settings.width * settings.height }
}
