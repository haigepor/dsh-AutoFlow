/** Ordered native-pixel references and a frozen, scene-specific background editing request. */
import sharp from 'sharp'
import type { z } from 'zod'
import type { wallpaperGenerationBriefOutputSchema } from '../shared/wallpaper-generation-brief.ts'
import type { WallpaperPlan, WallpaperItem, WallpaperSettings } from '../shared/wallpaper.ts'
import { wallpaperAttemptReview, wallpaperEdgeRepairAuthorized } from '../shared/wallpaper.ts'
import { wallpaperExpansionReview, wallpaperGenerativeRepair, wallpaperPracticalAcceptance } from '../shared/wallpaper-policy.ts'
import { wallpaperStackedSubjects, wallpaperEnclosingRect, wallpaperLayoutCoordinates, wallpaperPositionedLayout, wallpaperSourceContinuationTargets, type wallpaperGeometry } from '../shared/wallpaper-geometry.ts'

type Region = WallpaperPlan['regions'][number]['rect']
type Reference = { data: Uint8Array; mediaType: 'image/png' | 'image/webp' | 'image/jpeg'; name: string; role: 'canvas' | 'original' | 'subject-detail' | 'critical-detail' | 'layout-only'; sourceRect?: Region }
type PositionedLayout = ReturnType<typeof wallpaperPositionedLayout>
type RejectedLayout = { checks: readonly string[]; actualCore: readonly { name: string; entityId?: string | undefined; rect: Region; outline?: Region | undefined; role?: 'subject' | 'critical' | undefined }[] }
type ScenePlacementRule = 'focal-target-v1' | 'focal-target-v2' | 'focal-target-v3'

/** @param plan Frozen original observations. @param settings Frozen output dimensions. @param layout The positioned source regions. @param rejectedLayout Complete observations of a reviewed earlier draft. @returns A geometry-only guide and matching instructions for two fully visible, vertically stacked subjects. */
export async function wallpaperStackedGroupGuide(plan: WallpaperPlan, settings: WallpaperSettings, layout: PositionedLayout, rejectedLayout?: RejectedLayout): Promise<{ reference: Reference; instructions: string } | undefined> {
  const policy = wallpaperExpansionReview(settings)
  if (policy?.version !== 'expansion-first-v2') return undefined
  const stack = wallpaperStackedSubjects(plan, layout.positionedRegions)
  if (!stack) return undefined
  const [upper, lower] = stack
  const sourceLeft = Math.min(upper.rect.x, lower.rect.x)
  const source = { x: sourceLeft, y: upper.rect.y, width: Math.max(upper.rect.x + upper.rect.width, lower.rect.x + lower.rect.width) - sourceLeft, height: lower.rect.y + lower.rect.height - upper.rect.y }
  const safe = layout.protectedNormalized, safeWidth = safe.right - safe.left, safeHeight = safe.bottom - safe.top
  const marginRatio = (1 - policy.minimumPlannedScaleRatio) / 2
  const inset = settings.processing?.layoutInsetPixels ?? 0
  const marginX = Math.max(inset / settings.width, safeWidth * marginRatio)
  const marginY = Math.max(inset / settings.height, safeHeight * marginRatio)
  const observed = wallpaperEnclosingRect(rejectedLayout?.actualCore.filter(region => region.entityId === upper.entityId || region.entityId === lower.entityId).map(region => region.outline ?? region.rect) ?? [])
  const additional = (overflow: number, margin: number) => Math.min(margin / 2, Math.max(0, overflow))
  const left = safe.left + marginX + additional(observed ? safe.left - observed.x : 0, marginX)
  const right = safe.right - marginX - additional(observed ? observed.x + observed.width - safe.right : 0, marginX)
  const top = safe.top + marginY / 2 + additional(observed ? safe.top - observed.y : 0, marginY)
  const bottom = safe.bottom - marginY * 1.5 - additional(observed ? observed.y + observed.height - safe.bottom : 0, marginY)
  const scale = Math.min(1, (right - left) / source.width, (bottom - top) / source.height)
  const x = (left + right - source.width * scale) / 2, y = (top + bottom - source.height * scale) / 2
  const targets = [upper, lower].map(region => ({ ...region, rect: { x: x + (region.rect.x - source.x) * scale, y: y + (region.rect.y - source.y) * scale, width: region.rect.width * scale, height: region.rect.height * scale } }))
  const colors = ['#008d83', '#c23267']
  const { width, height } = settings
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1 1" preserveAspectRatio="none"><rect width="1" height="1" fill="#fafafa"/>${targets.map(({ rect }, i) => `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="none" stroke="${colors[i]}" stroke-width=".006"/>`).join('')}</svg>`
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`
  const instructions = [
    '把镜头向后拉，重新拍成一张有宽余背景的竖幅环境照片。保持原来的视角、上下承托关系和形状比例，整组主体随同一次拉远等比变小。',
    `以图1的全画幅和两个线框定位。上方青绿色框对应完整的${upper.name}，下方玫红色框对应完整的${lower.name}。两个框约束可见轮廓上限，连同最高点、最低接地处和相连结构一起放入对应范围。`,
    `画面顶部到整组最高点约留${percent(y)}画高的连续背景，最低点到底边约留${percent(1 - y - source.height * scale)}画高的自然前景。把下方空间补成与原场景连续的前景，完整保留原有接触面、承托和投影。`,
    '图1只是构图图示。原物外形、材质、光色和关系取自图2。交付自然完整的照片，画面中不出现框线、图示底色、拼接、原照贴片或遮挡主体的前景。',
  ].join('\n')
  return { reference: { data: await sharp(Buffer.from(svg)).png().toBuffer(), mediaType: 'image/png', name: 'wallpaper-group-layout.png', role: 'layout-only' }, instructions }
}

function focalPlacementInstructions(plan: WallpaperPlan, { protectedNormalized: safe, positionedRegions }: PositionedLayout, rejectedLayout?: RejectedLayout, useFrameMargins = false, settings?: WallpaperSettings): string {
  const subjects = positionedRegions.filter(region => region.role === 'subject')
  const planned = wallpaperEnclosingRect(subjects.map(region => region.rect))
  if (!planned) return ''
  const prior = subjects.flatMap(subject => {
    const [match, duplicate] = rejectedLayout?.actualCore.filter(region => subject.entityId ? subject.entityId === region.entityId : subject.name === region.name) ?? []
    return match && !duplicate ? [{ ...subject, rect: match.rect }] : []
  })
  const priorGroup = prior.length === subjects.length ? wallpaperEnclosingRect(prior.map(region => region.rect)) : undefined
  const keepPrior = !!priorGroup && rejectedLayout?.checks.length === 0
  const expansionReview = settings && wallpaperExpansionReview(settings)
  const rejectedCore = expansionReview && rejectedLayout && rejectedLayout.checks.some(check => /^(subject-overflow|critical-outside|automobile-outside):/.test(check)) ? rejectedLayout.actualCore : []
  const absolutePlacement = expansionReview?.version === 'expansion-first-v2'
  const marginRatio = absolutePlacement && !keepPrior && ['single', 'group'].includes(plan.mode)
    && !plan.objectRoles?.some(role => role.role !== 'supporting' && role.sourceEdges.length) ? (1 - expansionReview.minimumPlannedScaleRatio) / 2 : 0
  const core: RejectedLayout['actualCore'] = rejectedCore.length ? rejectedCore : marginRatio > 0
    ? positionedRegions.flatMap(region => region.role === 'anchor' ? [] : [{ ...region, role: region.role }]) : []
  const envelope = wallpaperEnclosingRect(core.map(region => region.outline ?? region.rect))
  const center = (start: number, span: number) => start + span / 2
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const inset = (span: number, dimension: number) => Math.min(span / 4, Math.max(span * marginRatio, (settings?.processing?.layoutInsetPixels ?? 0) / dimension))
  const insetX = inset(safe.right - safe.left, settings?.width ?? 1)
  const insetY = inset(safe.bottom - safe.top, settings?.height ?? 1)
  const correction = absolutePlacement && settings?.sourceIntentPolicy?.alignment === 'subject-fill-v1' && settings.sourceIntentPolicy.wholeSubjectSafety && rejectedCore.length ? envelope : undefined
  const extra = (overflow: number, inset: number) => Math.min(inset, Math.max(0, overflow))
  const targetLeft = safe.left + insetX + extra(correction ? safe.left - correction.x : 0, insetX)
  const targetRight = safe.right - insetX - extra(correction ? correction.x + correction.width - safe.right : 0, insetX)
  const targetTop = safe.top + insetY + extra(correction ? safe.top - correction.y : 0, insetY)
  const targetBottom = safe.bottom - insetY - extra(correction ? correction.y + correction.height - safe.bottom : 0, insetY)
  const scale = envelope ? Math.min(1, (targetRight - targetLeft) / envelope.width, (targetBottom - targetTop) / envelope.height) : 1
  const width = (envelope?.width ?? 0) * scale, height = (envelope?.height ?? 0) * scale
  const left = clamp(center(planned.x, planned.width) - width / 2, targetLeft, targetRight - width)
  const top = clamp(center(planned.y, planned.height) - height / 2, targetTop, targetBottom - height)
  const corrected = envelope ? core.map(region => {
    const rect = region.outline ?? region.rect
    return { ...region, rect: { x: left + (rect.x - envelope.x) * scale, y: top + (rect.y - envelope.y) * scale, width: rect.width * scale, height: rect.height * scale } }
  }) : []
  const targets = corrected.length ? corrected : keepPrior ? prior : subjects
  const targetGroup = envelope ? { x: left, y: top, width, height } : keepPrior ? priorGroup : planned
  const percent = (extent: number) => `${(extent * 100).toFixed(1)}%`
  const range = (start: number, end: number) => `${percent(start)}–${percent(end)}`
  const position = (rect: Region) => `横向${range(rect.x, rect.x + rect.width)}、纵向${range(rect.y, rect.y + rect.height)}`
  const corrections = !absolutePlacement && priorGroup && !envelope && rejectedLayout?.checks.some(check => check.startsWith('subject-center-drift:')) ? [
    { delta: planned.x + planned.width / 2 - priorGroup.x - priorGroup.width / 2, forward: '右', backward: '左', span: '画宽' },
    { delta: planned.y + planned.height / 2 - priorGroup.y - priorGroup.height / 2, forward: '下', backward: '上', span: '画高' },
  ].filter(({ delta }) => Math.round(Math.abs(delta) * 1000) !== 0)
    .map(({ delta, forward, backward, span }) => `向${delta > 0 ? forward : backward}移约${span}的${percent(Math.abs(delta))}`).join('、') : ''
  const resize = expansionReview && rejectedLayout?.checks.some(check => check.startsWith('subject-too-small'))
  const relative = expansionReview && rejectedLayout?.checks.some(check => /^subject-(relative-position|relative-scale|aspect-changed):/.test(check))
  const accessories = plan.objectRoles?.flatMap(object => {
    const accessory = object.sourceIntent?.visibleAccessoryExtent
    const target = targets.find(region => region.entityId === object.entityId)
    if (object.role !== 'primary' || object.safetyClass !== 'general' || !accessory || !target) return []
    const clearance = (accessory.y + accessory.height - object.rect.y - object.rect.height) * target.rect.height / object.rect.height
    const available = 1 - target.rect.y - target.rect.height
    const bottomRoom = clearance > 0 && clearance <= available ? `主体核心下缘之下约需留出画高的${percent(clearance)}容纳原有配件。` : ''
    return [`${object.name}的原图可见细长配件从接点到最后一环或末端都须保留在完整画框内。${bottomRoom}配件可离开安全区，仍须为末端和原有承托留出空间。保留连续路径与完整长度。`]
  }) ?? []
  return [
    `最终构图以完整竖图左上为起点计量。安全区横向${range(safe.left, safe.right)}、纵向${range(safe.top, safe.bottom)}。主体核心组的中心在成品高度${percent(targetGroup.y + targetGroup.height / 2)}，上缘在${percent(targetGroup.y)}，下缘在${percent(targetGroup.y + targetGroup.height)}。`,
    useFrameMargins ? `先以成品外框定位：从画布上沿到主体核心组最高轮廓留约${percent(targetGroup.y)}画高，从主体核心组最低轮廓到画布下沿留约${percent(1 - targetGroup.y - targetGroup.height)}画高。其间按以下核心框摆放，外侧空间用于自然背景和原有陪衬。主角固有结构计入自身轮廓，另列的承托物和陪衬各自保留。` : '',
    rejectedCore.length ? absolutePlacement
      ? `按终稿绝对坐标重绘整组，完整轮廓控制在${position(targetGroup)}。相连的上下端结构计入轮廓。主体下方保留连续背景，所有相连结构跟随主体，保留原有数量与相互位置。`
      : `上一版完整主体或关键结构越过安全区。把整组按上一版尺寸的${percent(scale)}等比重绘，移动到${position(targetGroup)}。四边均给完整轮廓留空，所有相连结构跟随主体，保留原有数量与相互位置。` : '',
    resize && !rejectedCore.length ? (absolutePlacement ? '把对应主体和原有相连部位画满给出的目标范围，留足安全区边距。' : '上一版主体过小。按下列范围放大对应主体及原有相连部位，留足安全区边距。') : '',
    relative ? '上一版组内比例、距离或长宽比有明显偏差。以原图的相互关系为准恢复，整组统一缩放和定位。' : '',
    corrections ? `上一版主体偏离目标。主体、必要相连结构和承托物整体${corrections}至下列成品坐标，不能独立移动部件或沿用偏移位置。` : '',
    keepPrior ? '上一版已核实的主体位置与尺度合格。按以下位置与尺度重新绘制整幅连续场景。' : '',
    ...targets.map(({ name, rect, role }) => `${name}的${role === 'critical' ? '关键轮廓' : '主体核心'}位于${position(rect)}。`),
    ...positionedRegions.filter(region => !envelope && !keepPrior && region.role === 'critical').map(({ name, rect }) => `${name}的关键轮廓位于${position(rect)}。`),
    ...accessories,
  ].filter(Boolean).join('\n')
}

/**
 * @param plan Frozen original observation, including protected regions and visual roles.
 * @param source Oriented original dimensions.
 * @param settings Target canvas dimensions.
 * @returns Whether the landscape source is an abstract pattern whose portrait crop would discard at least half its width.
 */
export function wallpaperUsesFullFrameTexture(plan: WallpaperPlan, source: { width: number; height: number }, settings: { width: number; height: number }): boolean {
  return plan.mode === 'abstract' && !plan.regions.length && !plan.actionPartIds?.length
    && plan.objectRoles?.every(object => object.role === 'supporting') === true
    && source.width > source.height && settings.height > settings.width
    && 2 * settings.width * source.height <= settings.height * source.width
}

/**
 * @param plan Frozen abstract theme and visual requirements.
 * @param settings Frozen output and clock-readability requirements.
 * @param corrections Previous review findings, used to distinguish corrective generation from the first request.
 * @returns Instructions for an edge-to-edge texture based on a single untouched source reference.
 */
export function wallpaperTextureCanvasPrompt(plan: WallpaperPlan, settings: WallpaperSettings, corrections: readonly string[] = []): string {
  return [
    `用唯一的原图参考生成一张连续、不透明的${settings.width}×${settings.height}竖幅壁纸，保持以下视觉主题。${plan.subject}`,
    '原图只提供纹理、色彩、光影、笔触、材质和图案节奏。按竖幅组织原有抽象语言，让纹理在整幅图中连贯流动并自然延伸到四边。疏密和细节可随竖幅调整。',
    plan.priorities.length ? `保留以下原图视觉特征。${plan.priorities.join('\n')}` : '',
    '不要保留原图的横向矩形外框或固定摆放位置，不要嵌入整张原图、平铺复制或做画中画。画面内不能出现矩形贴片、纹理断层、硬直拼接边、灰底占位或透明空洞。不新增人物、物体、标注或界面。',
    corrections.length ? '本轮从原图重新组织整幅纹理，保持颜色和材质连贯，消除内嵌贴片和断纹。' : '',
    settings.processing?.clockContrast ? `安全区上方背景须适合白色锁屏文字，对比度至少${settings.processing.clockContrast.minimumRatio}:1。壁纸本身不绘制时间、日期或界面。` : '',
  ].filter(Boolean).join('\n')
}

/**
 * @param plan Frozen source observations and scene-preservation requirements.
 * @param settings Frozen output and safety limits.
 * @param layout Planned protected regions in whole-output coordinates.
 * @param rejectedLayout Independently measured core rectangles and Host checks from a rejected attempt. An empty check list with mapped regions preserves a layout separately cleared in a seam-only repair.
 * @param placementRule Frozen focal-coordinate instructions. Omission preserves the historical request.
 * @param corrections Verified appearance or scene defects from the previous review.
 * @param groupInstructions Matching instructions for the geometry-only guide, when included.
 * @returns Instructions to rebuild a continuous scene from the original appearance and its optional group guide.
 */
export function wallpaperOriginalScenePrompt(plan: WallpaperPlan, settings: WallpaperSettings, layout: PositionedLayout, rejectedLayout?: RejectedLayout, placementRule?: ScenePlacementRule, corrections: readonly string[] = [], groupInstructions?: string): string {
  const { protectedNormalized, positionedRegions } = layout
  const minimumInsidePercent = (wallpaperPracticalAcceptance(settings)?.minimumCoreInsideRatio ?? 1) * 100
  const featureNames = { 'foliage-tip': '植物枝叶末梢', 'clothing-edge': '已有衣料外缘', 'thin-appendage': '现有细长附属物末端', 'repeat-structure-edge': '已有重复结构最后一片的外缘' }
  const adaptedEdges = plan.placement.adaptedSourceEdges?.map(({ entityId, edge, detail }) => ({ entityId, edge, feature: featureNames[detail] }))
  const useFrameMargins = placementRule === 'focal-target-v2' || placementRule === 'focal-target-v3'
  const focalInstructions = groupInstructions ?? (placementRule ? focalPlacementInstructions(plan, layout, rejectedLayout, useFrameMargins, settings) : '')
  return [
    `${groupInstructions ? '以图1确定成品构图，图2提供原场景外观。' : '以唯一原图为参考，'}重新生成一张连续、不透明的${settings.width}×${settings.height}竖幅壁纸。${useFrameMargins ? '先按下面的成品位置确定画面与主体，再重绘整个场景。' : `场景：${plan.subject}`}`,
    focalInstructions,
    useFrameMargins ? `场景：${plan.subject}` : '',
    `原图供识别主体、材质、光线和物体关系。延续原图媒介、画风和色调，按${useFrameMargins ? '上述成品位置' : '下方成品规划'}重建整个场景，使背景、阴影、纹理和透视连续延伸到画面四边，并融入主体与承托物。`,
    `将主体依照规划的整体比例、大小和位置放入安全区。完整可见车身和关键结构全部位于区内。其他主体至少${minimumInsidePercent}%的核心面积位于区内。保持原有身份、动作、数量、相对位置、正常遮挡和清晰细节。`,
    focalInstructions ? '成品不绘制定位线、日期或界面。' : `成品归一化坐标：${JSON.stringify({ protectedNormalized, positionedRegions })}。坐标以完整输出画面左上为原点。成品不绘制标注线、日期或界面。`,
    !focalInstructions && rejectedLayout?.actualCore.length ? `上版实际复审定位：${JSON.stringify(rejectedLayout)}。以当前positionedRegions为目标，在同一输出坐标中比较actualCore，整组纠正上版的位置与尺度偏差。同步移动关键结构，避免独立拉伸、移动部件或重复上版偏差。` : '',
    plan.priorities.length ? `原图应保留的细节：${plan.priorities.join('；')}。` : '',
    '尊重原图有意的半身、特写和裁切。出现在成品内部的原图边缘应按可见材质、形状和背景自然衔接。不要补造画外人物结构、虚构物体背面、复制主体或增加遮挡。',
    adaptedEdges ? `已核实可在画面内自然收束的实体外缘：${JSON.stringify(adaptedEdges)}。只在列出的实体和方向沿已有轮廓完成相应特征。保留手和身体原状，不新增肢体、翼片、太阳能阵列、机械结构或其他重复单元。其余原有取景保持不变。` : '',
    '重新绘制为一幅完整连贯的场景。不要缩放并嵌入原图矩形，不要用新背景包住照片，不要保留原图外边界、矩形贴片、描边、拼接线、硬直过渡、灰底或透明占位。',
    corrections.length ? `上版已确认的缺陷必须消除：${corrections.join('；')}。让场景和原有物体在原本的相邻位置自然连续。` : '',
    settings.processing?.clockContrast ? `安全区上方背景须适合白色锁屏文字，对比度至少${settings.processing.clockContrast.minimumRatio}:1。` : '',
  ].filter(Boolean).join('\n')
}

/** Expand the positioned master canvas with separate source-detail and safety-guide references.
 * @param plan Frozen source observations and the current scene-specific edit brief.
 * @param settings Frozen output and safety limits.
 * @param corrections Current localized defects from the previous independent review, without its coordinates or transcript.
 * @param positionedFrame Pixel bounds of the existing content in the rendered master after clipping to the target canvas.
 * @param focalLayout Frozen output-coordinate subject target; omission preserves the historical request.
 * @returns Compact visual instructions with one output-coordinate safe area and no pixel-restoration permission.
 */
export function wallpaperCompleteCanvasPrompt(plan: WallpaperPlan, settings: WallpaperSettings, corrections: readonly string[] = [], positionedFrame?: ReturnType<typeof wallpaperGeometry>['target'], focalLayout?: PositionedLayout): string {
  const actionParts = plan.objectRoles?.filter(object => plan.actionPartIds?.includes(object.entityId)).map(object => object.name) ?? []
  if (settings.sourceIntentPolicy?.version === 'source-intent-v2') return [
    `按图1的四边扩图，输出${settings.width}×${settings.height}完整竖幅图片。沿用图1已有画面在成品中的位置、大小、主体占比和留边。`,
    focalLayout ? focalPlacementInstructions(plan, focalLayout) : '',
    '图1是唯一构图基准和蒙版所对应的主画布。蒙版透明区的灰色为待扩背景，不透明区保留现有画面。',
    positionedFrame ? `图1已有画面的外框约在成品横向${(positionedFrame.left / settings.width * 100).toFixed(1)}%–${((positionedFrame.left + positionedFrame.width) / settings.width * 100).toFixed(1)}%、纵向${(positionedFrame.top / settings.height * 100).toFixed(1)}%–${((positionedFrame.top + positionedFrame.height) / settings.height * 100).toFixed(1)}%。按此范围定位已有内容，用连续背景补齐空白。` : '',
    '图2是完整原图，仅核对外观、动作、细节和画风。禁止按图2重新取景、缩放主体或直接返回图2。图3是同坐标的安全区规划图，仅核对安全边界和主体标注。',
    '按图1整体保留人物、持握、空手手势、手持物及彼此位置和遮挡，不单独移动或重画。保留原有半身、特写和画框截断，不补造画外身体，不裁掉、遮盖或渐隐已有内容。',
    settings.sourceIntentPolicy.alignment === 'subject-fill-v1' ? '保留图1对外围背景的取舍。' : '',
    actionParts.length ? `完整保留图1中的${actionParts.join('、')}，从原有连接处到最远可见末端保持连续、姿态和尺寸。` : '',
    '只沿原图光线、透视、颜色和笔触自然延展背景，接缝连续；不要复制标注线、编号、罩色或灰色占位，不添加重复主体、矩形贴片、日期和界面。',
    corrections.length ? `上一轮需纠正：${[...new Set(corrections)].join('；')}。位置与大小统一恢复到图1，不重新设计构图。` : '',
    settings.processing?.clockContrast ? `安全区上方背景须适合白色锁屏文字，对比度至少${settings.processing.clockContrast.minimumRatio}:1；图内不生成文字。` : '',
  ].filter(Boolean).join('\n')
  const safe = wallpaperLayoutCoordinates(settings).protectedNormalized
  const objects = plan.objectRoles?.filter(object => object.role !== 'supporting') ?? []
  const focused = settings.sourceIntentPolicy ? objects.filter(object => object.role === 'primary' && object.safetyClass !== 'automobile' && object.sourceIntent?.layoutFocus) : []
  const complete = objects.filter(object => !focused.includes(object))
  const medium = plan.sourceMedium && { photograph: '摄影', illustration: '插画', painting: '绘画', 'three-dimensional': '三维材质', graphic: '平面设计', mixed: '混合媒介', uncertain: '原有媒介' }[plan.sourceMedium]
  return [
    `以图1的完整目标画布为主图扩图，输出${settings.width}×${settings.height}自然连续的竖幅壁纸。主题：${plan.subject}${medium ? ` 保持原有${medium}风格。` : ''}`,
    focalLayout ? focalPlacementInstructions(plan, focalLayout) : '',
    '图1是已按规划摆放原图的主编辑画布，灰色空白为待扩背景；图2是完整原图，只核对人物、细节和画风；图3是安全区规划图，只参考安全边界和主体标注，不复制标注线、编号或罩色。',
    plan.editPrompt ? `本轮编辑：${plan.editPrompt}` : `保留：${[...plan.priorities, ...plan.anchors].join('；')}`,
    corrections.length ? `本轮修正：${[...new Set(corrections)].join('；')}` : '',
    `构图：保持图1已摆放好的主体位置、大小和相互比例，不再次缩放或移动；${plan.mode === 'scene' || plan.mode === 'abstract' ? '保留原有整体构图与视觉重心，不新增主角。' : '保持主体醒目，不拉远成小主体。'}安全区为完整成品横向${(safe.left * 100).toFixed(1)}%–${(safe.right * 100).toFixed(1)}%、纵向${(safe.top * 100).toFixed(1)}%–${(safe.bottom * 100).toFixed(1)}%。${focused.length ? `${focused.map(object => object.name).join('、')}的视觉核心放入该区域，原有半身取景、特写和遮挡保持不变。` : ''}${complete.length ? `${complete.map(object => object.name).join('、')}的完整可见范围放入该区域。` : focused.length || plan.mode === 'scene' || plan.mode === 'abstract' ? '' : '各主角与重要结构放入该区域。'}`,
    '保持图2中的身份、表情、姿态、材质、重要文字与持握关系；完整保留已有可见内容，不补画原图未见的身体或未知结构，不新增遮挡，也不以背景、涂抹或渐隐遮盖已有主体。',
    `背景沿用原有光线、透视、色彩与纹理自然延展。${plan.backgroundBrief ? plan.backgroundBrief.light : ''}`,
    settings.processing?.clockContrast ? `安全区上方背景须适合白色锁屏文字，对比度至少${settings.processing.clockContrast.minimumRatio}:1；图内不生成文字。` : '',
    '不生成矩形贴片、拼接边界、重复主体、标注线、日期或界面。',
  ].filter(Boolean).join('\n')
}

/** Bind a positioned edit to a master canvas and independent appearance and layout references.
 * @param original Encoded appearance reference selected within the attachment byte limit.
 * @param canvas Unmarked target canvas in output coordinates.
 * @param layout Safety guide in the same coordinates as the master.
 * @returns Master, original appearance and layout guide in provider request order.
 */
export function wallpaperPositionedGenerationReferences(original: Pick<Reference, 'data' | 'mediaType'>, canvas: Uint8Array, layout: Uint8Array): Reference[] {
  return [
    { data: canvas, mediaType: 'image/png', name: 'wallpaper-positioned-master.png', role: 'canvas' },
    { ...original, name: `wallpaper-original.${original.mediaType.slice(6)}`, role: 'original' },
    { data: layout, mediaType: 'image/png', name: 'wallpaper-safety-guide.png', role: 'layout-only' },
  ]
}

/** Prepare the edit canvas, original, native detail crops and a separately labelled layout guide.
 * @param original Verified, oriented source pixels. @param canvas Unmarked target canvas. @param layout Diagnostic safe-area overlay. @param plan Current inferred protection regions.
 * @param singleCanvas True retains the transparent canvas protocol; opaque supplies a gray placeholder.
 * @param includeOriginalReference Preserve the same production original as a separate style/detail reference, never another composition.
 * @returns Ordered lossless image inputs. The edit mask belongs only to the first image. Attachment admission may further normalize these references.
 */
export async function wallpaperGenerationReferences(original: Uint8Array, canvas: Uint8Array, layout: Uint8Array, plan: WallpaperPlan, singleCanvas: boolean | 'opaque' = false, includeOriginalReference = false): Promise<Reference[]> {
  if (singleCanvas) return [
    { data: singleCanvas === 'opaque' ? await sharp(canvas).flatten({ background: { r: 128, g: 128, b: 128 } }).png().toBuffer() : canvas, mediaType: 'image/png', name: 'wallpaper-canvas.png', role: 'canvas' },
    ...(includeOriginalReference ? [{ data: await sharp(original).png().toBuffer(), mediaType: 'image/png' as const, name: 'wallpaper-original-style-only.png', role: 'original' as const }] : []),
  ]
  const metadata = await sharp(original).metadata(), width = metadata.width!, height = metadata.height!
  const references: Reference[] = [
    { data: canvas, mediaType: 'image/png', name: 'wallpaper-canvas.png', role: 'canvas' },
    { data: await sharp(original).webp({ lossless: true, exact: true }).toBuffer(), mediaType: 'image/webp', name: 'wallpaper-original.webp', role: 'original' },
  ]
  const crop = async (rect: Region, role: 'subject-detail' | 'critical-detail') => {
    const left = Math.max(0, Math.floor(rect.x * width)), top = Math.max(0, Math.floor(rect.y * height))
    const right = Math.min(width, Math.ceil((rect.x + rect.width) * width)), bottom = Math.min(height, Math.ceil((rect.y + rect.height) * height))
    references.push({ data: await sharp(original).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer(), mediaType: 'image/png', name: `wallpaper-${role}.png`, role, sourceRect: { x: left / width, y: top / height, width: (right - left) / width, height: (bottom - top) / height } })
  }
  const subjects = plan.regions.filter(region => region.role === 'subject')
  if (subjects.length) {
    const x = Math.min(...subjects.map(region => region.rect.x)), y = Math.min(...subjects.map(region => region.rect.y))
    await crop({ x, y, width: Math.max(...subjects.map(region => region.rect.x + region.rect.width)) - x, height: Math.max(...subjects.map(region => region.rect.y + region.rect.height)) - y }, 'subject-detail')
  }
  const critical = plan.regions.filter(region => region.role === 'critical').sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]
  if (critical) await crop(critical.rect, 'critical-detail')
  references.push({ data: layout, mediaType: 'image/png', name: 'wallpaper-layout-only.png', role: 'layout-only' })
  return references
}

/** Freeze model-authored scene instructions together with exact reference roles and known review defects.
 * @param instruction Versioned background-only policy. @param plan Current model observation and scene edit brief. @param settings Frozen target geometry. @param references Ordered references after attachment normalization. @param attempts Retained attempts, including independent failed reviews.
 * @param sourceGeometry Original dimensions for the single-canvas protocol; omission preserves the earlier prompt fields.
 * @param opaqueCanvas The separate alpha mask marks editable areas in an opaque full-frame reference.
 * @param brief Saved reviewer-authored artistic requirements; absent retains the frozen legacy request.
 * @returns Exact prompt with requested native output distinct from input/reference coordinates; no prior verdict is promoted to current acceptance.
 */
export function wallpaperGenerationPrompt(instruction: string, plan: WallpaperPlan, settings: WallpaperSettings, references: readonly { role: Reference['role']; width: number; height: number; sourceRect?: Region }[], attempts: WallpaperItem['attempts'], sourceGeometry?: { width: number; height: number }, opaqueCanvas = false, brief?: z.infer<typeof wallpaperGenerationBriefOutputSchema>): string {
  const prior = wallpaperAttemptReview(attempts.findLast(attempt => wallpaperAttemptReview(attempt)))
  if (sourceGeometry && brief) {
    const latest = attempts.at(-1)
    const sourceLock = latest?.compositionMode === 'generated-canvas-protected-v2'
    const candidateLock = latest?.layoutCorrection?.version === 'candidate-placement-locked-v2'
    const referenceRoles = references.length > 1
      ? '第1张参考图是唯一的构图与位置依据；第2张原图只供核对画风、材质和健康细节，不采用它的取景。'
      : '第1张参考图是完整画布及唯一构图依据。'
    const clock = settings.processing?.clockContrast
      ? `系统会在画面宽度约25%–75%、高度约15%–31%的区域另行叠加白色日期和时间。该区域原有背景如果过亮，优先自然压暗背景、减弱亮叶和反光，使白字至少达到${settings.processing.clockContrast.minimumRatio}:1对比；此处背景亮度调整优先于背景像素原样保留，但主体、位置和材质必须保留。壁纸本身不绘制时间、日期或界面。`
      : '壁纸本身不绘制系统时间、日期或界面。'
    const correction = latest?.layoutCorrection ? `第1张是已保存的完整候选，Host已执行本轮整体等比缩放和平移。保持参考画布中的当前位置、内部比例和对象；${prior?.checks.background.result === 'violated' ? '修复复审已定位的背景缺陷，并补齐新露出的背景；保留健康主体，交付一张连续完整的画面' : '只补新露出的背景'}。历史复审中的下移、缩小等动作已经完成，不要再次执行，也不要为铺满画布放大主体。` : ''
    const repair = !latest?.layoutCorrection && latest && wallpaperEdgeRepairAuthorized(latest, settings) ? latest.detailAnalysis?.edgeRepair?.instruction : undefined
    const continuationTargets = wallpaperSourceContinuationTargets(plan, settings, sourceGeometry)
    const interiorTargets = continuationTargets.filter(target => target.disposition === 'interior')
    const frameCrops = continuationTargets.filter(target => target.disposition === 'final-frame-crop')
    return [referenceRoles, candidateLock ? plan.editPrompt : brief.generationPrompt, clock,
      '输出与第1张相同视野的完整、不透明竖幅画面。保留原图的共同主体、健康细节和自然取景；新增画布区域可依据原有光线、透视、景深和材质主动生成合理场景细节。场景自然延伸至画布四边，消除灰色占位、透明空洞、不规则裁切黑边、彩色轮廓、重复主体与扩图接缝。',
      sourceLock ? 'Host会在交付时逐像素恢复画布中全部健康原图；重点让新增画布与原图边界的颜色、轮廓、景深和纹理自然相接。原图边缘已裁切的花束等陪衬不可变成清晰的新花瓣或重复物体；整幅生成背景必须不透明。' : '',
      opaqueCanvas ? `灰色区域及蒙版透明处需要补画；${settings.processing?.clockContrast ? '按显式时钟规则自然调整必要的背景亮度；' : ''}其余不透明原图像素尽量保留。` : '',
      correction, candidateLock ? 'Host会保留本轮已定位的完整生成候选像素，仅采用外围新背景；不能重画、重复或移动其中的空间关系。' : '', repair ?? '',
      `画风与关键细节：${JSON.stringify({ styleAnchors: brief.styleAnchors, detailAnchors: brief.detailAnchors })}`,
      interiorTargets.length ? `成品内部需要自然补全的原图断口：${JSON.stringify(interiorTargets.map(({ entityId, name, edge }) => ({ entityId, name, edge })))}。此处优先于前文任何“短距收口”或“不补完整”的旧表述：根据每件物体已有的轴线、材质、透视和光照，合理生成成品视角下应当可见的完整局部外形，允许重绘蒙版开放的断口及相邻过渡；盖顶、侧壁、刷柄端头和盘框所需的可见延续不受固定长度限制。保留产品身份、数量和主次关系，不虚构品牌或未知背面。` : '',
      frameCrops.length ? `仍处于最终画框裁切的原图边缘：${JSON.stringify(frameCrops.map(({ entityId, name, edge }) => ({ entityId, name, edge })))}。这些部分可以自然出画，不为补全它们而移动或缩小核心主体。` : '',
      brief.clockText.action === 'remove-generated-overlay' ? '擦除上一轮生成图中新添的日期或时间，并补回自然背景。' : '',
      `Host布局数据：${JSON.stringify({ ...wallpaperPositionedLayout(plan, sourceGeometry, settings), referenceImageVersionId: latest?.opaqueCanvasId, layoutCorrectionApplied: !!latest?.layoutCorrection })}。positionedRegions与protectedNormalized均以输出整张画布为基准；appliedSourceTransform仅记录已执行的历史变换，objectRoles只标识冻结角色，不含定位坐标。核心主体及关键部位须完整位于protectedNormalized内，陪衬和原图有意截断内容不冒充核心主体。保持本轮参考中已定位的主体，不重复执行历史位移动作。输出较小图片时保持同一视野与比例，复审通过后再由Host超分。`,
    ].filter(Boolean).join('\n')
  }
  if (sourceGeometry) {
    const width = Math.round(sourceGeometry.width * plan.placement.scale), height = Math.round(sourceGeometry.height * plan.placement.scale)
    const normalizedPlacement = { x: plan.placement.left / settings.width, y: plan.placement.top / settings.height, width: width / settings.width, height: height / settings.height }
    const latest = attempts.at(-1), correction = latest?.layoutCorrection, detail = correction ? undefined : latest?.detailAnalysis, repair = latest && !correction && wallpaperEdgeRepairAuthorized(latest, settings) ? detail?.edgeRepair : undefined
    const outputInstruction = opaqueCanvas ? `请求输出${settings.imageSize}/${settings.imageQuality}，最终壁纸为${settings.width}×${settings.height}。服务返回较小图像时由Host独立超分；仍须返回整张画布的相同视野和比例，不得把内部原图裁出、铺满或放大。中性灰只是待扩图占位色，须替换为连续背景。` : `最终交付的原生图像尺寸为${settings.imageSize}，渲染质量为${settings.imageQuality}，与本次图片请求参数一致。output规定最终生成结果；canvas仅描述输入参考图尺寸，template仅用于固定构图坐标。保持normalizedPlacement与protectedRegions的相对位置，在output尺寸上原生渲染完整画布；不得用缩略图、裁切或生成后放大替代目标输出。`
    const clockInstruction = settings.processing?.clockContrast && prior?.checks.readability.result !== undefined && prior.checks.readability.result !== 'satisfied' ? `只输出没有日期、时间和界面的干净背景。系统将在交付后独立叠加白字；本次只自然调整其覆盖区域的天空或背景亮度，使白字对比至少${settings.processing.clockContrast.minimumRatio}:1；不能保留近白背景，不加文字、描边、假时钟、矩形黑块或生硬渐变，主体和场景其余部分尽量保留。` : ''
    const authored = brief ? `\nsceneEditPrompt是审查模型根据原始像素整理的最终执行提示词，须遵守其中具体艺术技法与细节要求。\n只交付干净背景，系统日期和时间会在之后独立叠加；任何参考中模型新增的日期、时间必须擦除并补回自然背景。` : ''
    const roleInstruction = references.length > 1 ? '\n第1参考是唯一的构图与定位主画布；第2参考是同一原始输入的画风与健康细节参考，仅恢复纸纹、笔触、毛流、菌褶或实际材质，不复制其原始取景，不产生第二组主体，不以它覆盖主画布布局。' : ''
    return `${instruction}${authored}${roleInstruction}\n${outputInstruction}${clockInstruction ? '\n' + clockInstruction : ''}\n${JSON.stringify({ taskPolicy: settings.repairPolicy, objectRoles: plan.objectRoles, repairTargets: wallpaperGenerativeRepair(settings) ? { truncations: plan.truncations, uncertainties: plan.uncertainties, defects: prior?.issues ?? [], generatedRepair: true } : undefined, sceneEditPrompt: brief?.generationPrompt ?? plan.editPrompt, ...(brief ? { styleAnchors: brief.styleAnchors, detailAnchors: brief.detailAnchors, clockText: brief.clockText, referenceRoles: references.map((reference, index) => ({ image: index + 1, ...reference })) } : {}), output: { size: settings.imageSize, quality: settings.imageQuality }, canvas: references[0], ...(opaqueCanvas ? { canvasEncoding: { placeholderRgb: [128, 128, 128], editablePixels: 'separate-mask-transparent' } } : {}), template: { width: settings.width, height: settings.height, safe: settings.safe, topBuffer: settings.processing?.clockContrast ? settings.topBuffer : 0 }, normalizedPlacement,
      protectedRegions: plan.regions.map(region => ({ name: region.name, entityId: region.entityId, role: region.role, rect: { x: normalizedPlacement.x + region.rect.x * normalizedPlacement.width, y: normalizedPlacement.y + region.rect.y * normalizedPlacement.height, width: region.rect.width * normalizedPlacement.width, height: region.rect.height * normalizedPlacement.height } })),
      candidatePlacement: correction ? { version: correction.version, sourceImageVersionId: plan.imageVersionId, instruction: `The reference is an independently complete saved candidate, uniformly placed as a whole. Preserve its objects and internal proportions; ${prior?.checks.background.result === 'violated' ? 'repair the localized background defects and extend exposed background' : 'extend only exposed background'}${settings.processing?.clockContrast ? ' and repair configured clock contrast' : ''}. Return one continuous complete scene. Do not enlarge its central scene to fill the canvas.` } : undefined,
      edgeRepair: repair ? { classification: repair.classification, edges: repair.edges, reason: repair.reason, instruction: repair.instruction, ...(repair.sourceRegion ? { normalizedTargetRegion: { x: normalizedPlacement.x + repair.sourceRegion.x * normalizedPlacement.width, y: normalizedPlacement.y + repair.sourceRegion.y * normalizedPlacement.height, width: repair.sourceRegion.width * normalizedPlacement.width, height: repair.sourceRegion.height * normalizedPlacement.height } } : {}) } : undefined,
      retainedUnknowns: detail?.findings?.filter(finding => finding.result === 'unresolved' && !finding.blocking).map(finding => ({ concernId: finding.concernId, classification: finding.classification, reason: finding.reason })),
      framingFailure: latest?.compositionMode === 'generated-canvas-v1' ? undefined : attempts.findLast(attempt => ['reframed-source', 'misaligned-source'].includes(attempt.generationAlignment?.result ?? ''))?.generationAlignment,
      ...(latest?.compositionMode === 'generated-canvas-v1' ? { alignmentDiagnostic: { measurement: attempts.findLast(attempt => attempt.generationAlignment)?.generationAlignment, instruction: 'Fixed-position pixel correlation is diagnostic only. It does not establish a layout or content defect; use the independent review and the current positioned reference.' } } : {}),
      canvasAspectFailure: attempts.findLast(attempt => attempt.generationFramingFailure)?.generationFramingFailure,
      previousDefects: prior ? Object.entries(prior.checks).filter(([, check]) => check.result !== 'satisfied').map(([check, result]) => ({ check, ...result })) : [] })}`
  }
  return `${instruction}\n${JSON.stringify({ sceneEditPrompt: brief?.generationPrompt ?? plan.editPrompt ?? { subject: plan.subject, evidence: plan.evidence, priorities: plan.priorities, anchors: plan.anchors, reason: plan.reason }, objectRoles: plan.objectRoles, referenceRoles: references.map((reference, index) => ({ image: index + 1, ...reference })), template: { width: settings.width, height: settings.height, safe: settings.safe, topBuffer: settings.processing?.clockContrast ? settings.topBuffer : 0 }, placement: plan.placement, protectedRegions: plan.regions, previousDefects: prior ? Object.entries(prior.checks).filter(([, check]) => check.result !== 'satisfied').map(([check, result]) => ({ check, ...result })) : [] })}`
}
