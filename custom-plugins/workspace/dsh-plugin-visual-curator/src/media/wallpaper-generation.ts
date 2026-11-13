/** Ordered native-pixel references and a frozen, scene-specific background editing request. */
import sharp from 'sharp'
import type { z } from 'zod'
import type { wallpaperGenerationBriefOutputSchema } from '../shared/wallpaper-generation-brief.ts'
import type { WallpaperPlan, WallpaperItem, WallpaperSettings } from '../shared/wallpaper.ts'
import { wallpaperEdgeRepairAuthorized } from '../shared/wallpaper.ts'
import { wallpaperGenerativeRepair } from '../shared/wallpaper-policy.ts'
import { wallpaperLayoutCoordinates, wallpaperSourceContinuationTargets } from '../shared/wallpaper-geometry.ts'

type Region = WallpaperPlan['regions'][number]['rect']
type Reference = { data: Uint8Array; mediaType: 'image/png' | 'image/webp'; name: string; role: 'canvas' | 'original' | 'subject-detail' | 'critical-detail' | 'layout-only'; sourceRect?: Region }

/** Prepare the edit canvas, original, native detail crops and a separately labelled layout guide.
 * @param original Verified, oriented source pixels. @param canvas Unmarked target canvas. @param layout Diagnostic safe-area overlay. @param plan Current inferred protection regions.
 * @param singleCanvas True retains the transparent canvas protocol; opaque supplies a full-frame gray placeholder with editability owned by the separate mask.
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
  const prior = attempts.findLast(attempt => attempt.review)?.review
  if (sourceGeometry && brief) {
    const latest = attempts.at(-1)
    const sourceLock = latest?.compositionMode === 'generated-canvas-protected-v2'
    const referenceRoles = references.length > 1
      ? '第1张参考图是唯一的构图与位置依据；第2张原图只供核对画风、材质和健康细节，不采用它的取景。'
      : '第1张参考图是完整画布及唯一构图依据。'
    const clock = settings.processing?.clockContrast
      ? `系统会在画面宽度约25%–75%、高度约15%–31%的区域另行叠加白色日期和时间。该区域原有背景如果过亮，优先自然压暗背景、减弱亮叶和反光，使白字至少达到${settings.processing.clockContrast.minimumRatio}:1对比；此处背景亮度调整优先于背景像素原样保留，但主体、位置和材质必须保留。壁纸本身不绘制时间、日期或界面。`
      : '壁纸本身不绘制系统时间、日期或界面。'
    const correction = latest?.layoutCorrection ? '第1张是已保存的完整候选，Host已执行本轮整体等比缩放和平移。保持参考画布中的当前位置、内部比例和对象；只补新露出的背景。历史复审中的下移、缩小等动作已经完成，不要再次执行，也不要为铺满画布放大主体。' : ''
    const repair = !latest?.layoutCorrection && latest && wallpaperEdgeRepairAuthorized(latest, settings) ? latest.detailAnalysis?.edgeRepair?.instruction : undefined
    const continuationTargets = wallpaperSourceContinuationTargets(plan, settings, sourceGeometry)
    const interiorTargets = continuationTargets.filter(target => target.disposition === 'interior')
    const frameCrops = continuationTargets.filter(target => target.disposition === 'final-frame-crop')
    return [referenceRoles, brief.generationPrompt, clock,
      '输出与第1张相同视野的完整竖幅画面。保留原图的共同主体、健康细节和自然取景；新增画布区域可依据原有光线、透视、景深和材质主动生成合理场景细节，形成完整画面，消除灰色占位、重复主体与扩图接缝。',
      sourceLock ? 'Host会在交付时逐像素恢复画布中全部健康原图；重点让新增画布与原图边界的颜色、轮廓、景深和纹理自然相接。原图边缘已裁切的花束等陪衬不可变成清晰的新花瓣或重复物体；整幅生成背景必须不透明。' : '',
      opaqueCanvas ? `灰色区域及蒙版透明处需要补画；${settings.processing?.clockContrast ? '按显式时钟规则自然调整必要的背景亮度；' : ''}其余不透明原图像素尽量保留。` : '',
      correction, repair ?? '',
      `画风与关键细节：${JSON.stringify({ styleAnchors: brief.styleAnchors, detailAnchors: brief.detailAnchors })}`,
      interiorTargets.length ? `成品内部需要自然补全的原图断口：${JSON.stringify(interiorTargets.map(({ entityId, name, edge }) => ({ entityId, name, edge })))}。此处优先于前文任何“短距收口”或“不补完整”的旧表述：根据每件物体已有的轴线、材质、透视和光照，合理生成成品视角下应当可见的完整局部外形，允许重绘蒙版开放的断口及相邻过渡；盖顶、侧壁、刷柄端头和盘框所需的可见延续不受固定长度限制。保留产品身份、数量和主次关系，不虚构品牌或未知背面。` : '',
      frameCrops.length ? `仍处于最终画框裁切的原图边缘：${JSON.stringify(frameCrops.map(({ entityId, name, edge }) => ({ entityId, name, edge })))}。这些部分可以自然出画，不为补全它们而移动或缩小核心主体。` : '',
      brief.clockText.action === 'remove-generated-overlay' ? '擦除上一轮生成图中新添的日期或时间，并补回自然背景。' : '',
      `Host布局数据：${JSON.stringify({ ...wallpaperLayoutCoordinates(settings), referenceImageVersionId: plan.imageVersionId, referenceTransformAlreadyApplied: true, placement: plan.placement, layoutCorrectionApplied: !!latest?.layoutCorrection, objectRoles: plan.objectRoles })}。所有坐标均以输出整张画布为基准；核心主体及关键部位须完整位于protectedNormalized内，陪衬和原图有意截断内容不冒充核心主体。保持本轮参考中已定位的主体，不重复执行历史位移动作。输出较小图片时保持同一视野与比例，复审通过后再由Host超分。`,
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
      candidatePlacement: correction ? { version: correction.version, sourceImageVersionId: plan.imageVersionId, instruction: `The reference is an independently complete saved candidate, uniformly placed as a whole. Preserve its objects and internal proportions; extend only exposed background${settings.processing?.clockContrast ? ' and repair configured clock contrast' : ''}. Do not enlarge its central scene to fill the canvas.` } : undefined,
      edgeRepair: repair ? { classification: repair.classification, edges: repair.edges, reason: repair.reason, instruction: repair.instruction, ...(repair.sourceRegion ? { normalizedTargetRegion: { x: normalizedPlacement.x + repair.sourceRegion.x * normalizedPlacement.width, y: normalizedPlacement.y + repair.sourceRegion.y * normalizedPlacement.height, width: repair.sourceRegion.width * normalizedPlacement.width, height: repair.sourceRegion.height * normalizedPlacement.height } } : {}) } : undefined,
      retainedUnknowns: detail?.findings?.filter(finding => finding.result === 'unresolved' && !finding.blocking).map(finding => ({ concernId: finding.concernId, classification: finding.classification, reason: finding.reason })),
      framingFailure: latest?.compositionMode === 'generated-canvas-v1' ? undefined : attempts.findLast(attempt => ['reframed-source', 'misaligned-source'].includes(attempt.generationAlignment?.result ?? ''))?.generationAlignment,
      ...(latest?.compositionMode === 'generated-canvas-v1' ? { alignmentDiagnostic: { measurement: attempts.findLast(attempt => attempt.generationAlignment)?.generationAlignment, instruction: 'Fixed-position pixel correlation is diagnostic only. It does not establish a layout or content defect; use the independent review and the current positioned reference.' } } : {}),
      canvasAspectFailure: attempts.findLast(attempt => attempt.generationFramingFailure)?.generationFramingFailure,
      previousDefects: prior ? Object.entries(prior.checks).filter(([, check]) => check.result !== 'satisfied').map(([check, result]) => ({ check, ...result })) : [] })}`
  }
  return `${instruction}\n${JSON.stringify({ sceneEditPrompt: brief?.generationPrompt ?? plan.editPrompt ?? { subject: plan.subject, evidence: plan.evidence, priorities: plan.priorities, anchors: plan.anchors, reason: plan.reason }, objectRoles: plan.objectRoles, referenceRoles: references.map((reference, index) => ({ image: index + 1, ...reference })), template: { width: settings.width, height: settings.height, safe: settings.safe, topBuffer: settings.processing?.clockContrast ? settings.topBuffer : 0 }, placement: plan.placement, protectedRegions: plan.regions, previousDefects: prior ? Object.entries(prior.checks).filter(([, check]) => check.result !== 'satisfied').map(([check, result]) => ({ check, ...result })) : [] })}`
}
