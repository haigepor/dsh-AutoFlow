/** Healthy source workflows separate observed content, measured placement and generated background quality. */
import { z } from 'zod'
import { wallpaperObjectRoleSchema, wallpaperObservationPlanSchema, wallpaperStoredSourceReviewV4Schema, wallpaperSourceReviewV4Schema, wallpaperBackgroundBriefSchema, type WallpaperPlan, type WallpaperSettings } from './wallpaper.ts'
import { wallpaperGeometry, wallpaperModelPlan, wallpaperPositionedLayout, wallpaperProtectedBounds } from './wallpaper-geometry.ts'

/** Canonical source observations omit duplicate protection rectangles and derivable frame-edge flags. */
export const wallpaperPreservationPlanSchema = wallpaperObservationPlanSchema.omit({ regions: true, objectRoles: true }).required({ editPrompt: true, sourceAssessment: true }).extend({
  objectRoles: z.array(wallpaperObjectRoleSchema.omit({ sourceEdges: true })).max(32),
}).superRefine((plan, ctx) => {
  if (new Set(plan.objectRoles.map(object => object.entityId)).size !== plan.objectRoles.length) ctx.addIssue({ code: 'custom', path: ['objectRoles'], message: 'Each entity must have one unique identity and role.' })
  if ((plan.mode === 'single' || plan.mode === 'group') && !plan.objectRoles.some(object => object.role === 'primary')) ctx.addIssue({ code: 'custom', path: ['objectRoles'], message: 'Identify the primary subject.' })
  if (plan.sourceAssessment.classification === 'ready' && (plan.truncations.length || plan.uncertainties.length)) ctx.addIssue({ code: 'custom', path: ['sourceAssessment'], message: 'Unresolved source damage or uncertainty cannot be classified ready.' })
})

/** Source inspection also authors the background brief; subsequent placement never asks the model to measure these objects again. */
export const wallpaperPreservationPlanPrompt = { version: 'wallpaper-plan-v10' as const, text: `检查wallpaper-original的真实像素，识别视觉主角及必要结构。只返回指定JSON。objectRoles中每个实体只出现一次：primary是主角，critical-part是主角不可缺少的自身结构，supporting是花瓶、托盘、背景花朵等陪衬；独立且承托主角的器具不因此升级为必要结构。rect完整包住该实体当前视角中应有的可见外形，包含吸管、耳朵等实际属于主角的细节。不要返回regions、placement或sourceEdges，Host据此统一计算保护框、画框接触边及安全区定位。
sourceAssessment：ready表示主角完整、健康且可直接保留原像素；repair-required表示存在具体断缺、异常结构或需修复的画框内断口；uncertain表示证据不足。正常遮挡、原有景深、不可见背面和无关小字不是损坏。truncations仅记录真正主角损坏，uncertainties记录真实且影响验收的疑点，不为陪衬接触原图画框制造主角损坏。主角的原裁切边若将在新画布内部暴露必须修复，不能称为完整。
backgroundBrief独立编写纯环境事实：setting只写窗、帘、墙、台面、地面等空场景；light写照明，palette写色调，texture写背景材质纹理，perspective写环境透视和可见线条。五项均禁止出现玩偶、人物、动物、饮品、杯具、食物、托盘等前景实体或“保留/重建这些对象”的指令。原图物体仍记录在objectRoles/anchors，不能把物体保留要求发送给只负责空背景的生成模型。editPrompt保留场景或真实损坏时的编辑要求。健康图后续只生成移除前景后的背景，原图按同一等比变换合成，禁止重新设计或移动主角。真实损坏的图走独立的授权主体修复流程。身份、文字、标识和未知内容不允许臆造为真实信息。` }

/** @param observation Canonical model observations. @returns Source regions and edge flags derived once for Host layout and retained history. */
export function wallpaperPreservationObservation(observation: z.infer<typeof wallpaperPreservationPlanSchema>) {
  const objectRoles = observation.objectRoles.map(object => ({ ...object, sourceEdges: (['left', 'top', 'right', 'bottom'] as const).filter(edge => edge === 'left' ? object.rect.x === 0 : edge === 'top' ? object.rect.y === 0 : edge === 'right' ? object.rect.x + object.rect.width >= 0.999 : object.rect.y + object.rect.height >= 0.999) }))
  return { ...observation, objectRoles, regions: objectRoles.filter(object => object.role !== 'supporting').map(object => ({ name: object.name, entityId: object.entityId, role: object.role === 'primary' ? 'subject' as const : 'critical' as const, rect: object.rect })) }
}

/** @param plan Source inspection and placement. @returns Whether intact foreground pixels can be retained without exposing an unfinished source edge. */
export function wallpaperCanPreserveSource(plan: WallpaperPlan): boolean {
  return plan.sourceAssessment?.classification === 'ready' && !plan.truncations.length && !plan.uncertainties.length && (plan.mode === 'scene' || plan.mode === 'abstract' || plan.regions.some(region => region.role === 'subject')) && !!plan.objectRoles?.every(object => object.role === 'supporting' || object.sourceEdges.length === 0)
}

/** @param source Oriented source dimensions. @param settings Frozen strict safety bounds. @returns One uniform whole-source placement retaining all visible content inside the safe rectangle, independently of inferred object boxes. */
export function fitWallpaperPreservedSource(source: { width: number; height: number }, settings: WallpaperSettings): WallpaperPlan['placement'] {
  const bounds = wallpaperProtectedBounds(settings), inset = settings.processing?.layoutInsetPixels ?? 0
  const scale = Math.min(1, (bounds.critical.right - bounds.critical.left - 2 * inset) / source.width, (bounds.critical.bottom - bounds.top - 2 * inset) / source.height)
  const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale))
  return { scale, left: Math.floor((bounds.critical.left + bounds.critical.right - width) / 2), top: Math.floor((bounds.top + bounds.critical.bottom - height) / 2) }
}

/** Final quality observations exclude layout coordinates already owned and verified by the compositor. */
const qualityFields = z.strictObject({
  version: z.literal('wallpaper-preserved-quality-v1'),
  checks: wallpaperSourceReviewV4Schema.shape.checks.omit({ protection: true }),
  issues: z.array(z.strictObject({ check: z.enum(['subject', 'clock', 'readability', 'composition', 'background', 'style', 'clarity']), reason: z.string().min(1).max(4096), rect: wallpaperObjectRoleSchema.shape.rect })).max(32),
})
function validateQualityIssues(review: z.infer<typeof qualityFields>, ctx: z.RefinementCtx) {
  for (const [key, check] of Object.entries(review.checks)) if (check.result !== 'satisfied' && !review.issues.some(issue => issue.check === key)) ctx.addIssue({ code: 'custom', path: ['issues'], message: `Locate the visible defect or unresolved evidence for ${key}.` })
  for (const [index, issue] of review.issues.entries()) if (review.checks[issue.check].result === 'satisfied') ctx.addIssue({ code: 'custom', path: ['issues', index], message: 'A blocking issue cannot accompany a satisfied check.' })
}
/** Historical final-quality responses retain their original checks without inventing object inventory evidence. */
export const wallpaperPreservedQualitySchema = qualityFields.superRefine(validateQualityIssues)

/** @param plan Frozen source entities. @returns Independent final inventory and junction observations; source-pixel preservation cannot establish absence of extra objects. */
export function wallpaperPreservedInventorySchema(plan: WallpaperPlan) {
  const ids = plan.objectRoles?.filter(object => object.role !== 'critical-part').map(object => object.entityId) ?? []
  return qualityFields.omit({ version: true }).extend({
    version: z.literal('wallpaper-preserved-quality-v2'),
    backgroundBrief: wallpaperBackgroundBriefSchema,
    inventory: z.array(z.strictObject({ entityId: ids.length ? z.enum(ids) : z.string(), status: z.enum(['retained', 'missing', 'changed', 'uncertain']), instances: z.array(wallpaperObjectRoleSchema.shape.rect).max(16), reason: z.string().min(1).max(240) })).length(ids.length),
    newForeground: z.array(z.strictObject({ name: z.string().min(1).max(240), reason: z.string().min(1).max(240), rect: wallpaperObjectRoleSchema.shape.rect })).max(16),
    transitions: z.array(z.strictObject({ edge: z.enum(['left', 'top', 'right', 'bottom']), result: z.enum(['satisfied', 'violated', 'unknown']), reason: z.string().min(1).max(240) })).length(4),
  }).superRefine((review, ctx) => {
    validateQualityIssues({ ...review, version: 'wallpaper-preserved-quality-v1' }, ctx)
    if (new Set(review.inventory.map(row => row.entityId)).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['inventory'], message: 'Observe every frozen source entity exactly once.' })
    if (new Set(review.transitions.map(row => row.edge)).size !== 4) ctx.addIssue({ code: 'custom', path: ['transitions'], message: 'Inspect each retained-source junction once.' })
  })
}

/** One final review judges actual pixels while the Host verifies protected source content and geometry. */
export const wallpaperPreservedQualityPrompt = { version: 'wallpaper-preserved-quality-v2' as const, text: `独立对照wallpaper-original与actual-wallpaper的真实像素，不预设生成或合成已成功。先完整扫描成品四角、边缘、前景和原图保留区域外，再回答inventory、newForeground和transitions，最后填写checks。每个reason只用一句短句。任何原图保留证据都不能证明扩展区没有额外物体或接缝。backgroundBrief只给窗/帘/墙/桌地等空场景的setting、light、palette、texture、perspective，禁止写任何玩偶、人物、动物、饮品、杯具、食物、托盘等前景实体或其保留/重建指令；供确认缺陷后的背景修复使用。
inventory逐个核对usage.sourceObjects提供的独立实体，primary与supporting都须核对。instances列出该实体在完整成品中的全部可见实例归一化框，不能只列中间保留的小图：例如原图一只玩偶、成品中央一只且右侧又一只，必须返回两个框；原图一个托盘、前景另出现第二个托盘也必须计入。不能把新复制的物体解释为自然层次、陪衬或允许的扩图。多个小物被命名为一组时按原有组合核对。newForeground记录不属于原图实体清单的新增玩偶、杯具、托盘或其它前景物体。原图健康物体的数量、内部相对关系和身份不得无故改变。只允许自然延续原图画框截断的同一陪衬，不允许额外独立副本。
transitions逐边检查usage.retainedSourceFrame的左、上、右、下接合处。成品不能出现清晰或模糊的嵌套矩形、局部缩小画面贴在另一整幅场景上、窗框台面错位、双层托盘、重复帘布、突变景深或色温。即使每一块单独好看，这些拼接痕迹仍是violated。不要把源图取景框的可见接缝当作合法的统一缩放。
位置和缩放合法性由Host单独检查，本请求不重新估算安全区或主体布局；只独立判断实际内容和衔接。保留区域之外仍须完整检查，禁止仅因原图像素被保留就判全部合格。
subject检查初次识别是否遗漏真实断缺、主角是否完整自然且满足任务；composition检查比例、透视、主从关系和场景自然性；background重点查接缝、重复物体、双重轮廓、平切边、镜像拼接、悬空物体及光照/透视不连续；style检查颜色、材质、场景及原图细节是否一致；clarity检查真实细节、噪声、模糊和过锐。原图与成品的统一缩放和平移合法，正常景深和原有遮挡不算缺陷。仅usage.settings.processing.clockContrast明确存在时才检查clock/readability；未启用时这两项返回satisfied并说明未启用，不因模拟时钟或顶部亮背景失败。成图自身新增文字或界面仍是background缺陷。
每个非satisfied检查必须在issues提供对应check、具体可见原因和完整成品归一化rect；unknown必须保留，不捏造问题。陪衬超出主角安全区本身不是缺陷。合格检查不列阻塞issues。所有真实缺陷都要阻止通过。` }

/** @param plan Canonical source content. @param attempts Saved quality failures. @returns Background-only instructions without permissions to redraw foreground. */
export function wallpaperBackgroundPlatePrompt(plan: WallpaperPlan, attempts: readonly { review?: { issues: readonly { reason: string }[]; backgroundBrief?: z.infer<typeof wallpaperBackgroundBriefSchema> | undefined } | undefined }[]): string {
  const background = attempts.findLast(attempt => attempt.review?.backgroundBrief)?.review?.backgroundBrief ?? plan.backgroundBrief
  return `Create an EMPTY seamless BACKGROUND ONLY environment matching the visible background context at exactly the same pixel scale and position. The existing unmasked window, curtain, wall, table or ground is a fixed alignment reference, not a small picture to enlarge. Fill grey erased foreground areas and the new exterior with continuous background. Keep the existing window-frame, horizon and table lines aligned through all four sides; no zoom, reframing, inset rectangle, collage panel or separate miniature scene. The final environment must be empty: no toys, animals, people, food, drinks, cups, plates, trays, text or logos. Never reconstruct erased foreground objects or invent copies elsewhere. Only a visible supporting background prop crossing the old source edge may continue as the SAME object; do not introduce another instance. The Host adds the original foreground once afterward. Output one opaque complete background at the requested size.\nBackground-only environment facts: ${JSON.stringify(background)}\nActual prior defects to remove, without repeating the pictured objects: ${JSON.stringify(attempts.flatMap(attempt => attempt.review?.issues.map(issue => issue.reason) ?? []))}`
}

/** @param quality Final visual findings. @param plan Frozen source placement. @param source Source pixels and dimensions. @param output Delivered pixels. @param settings Frozen template. @param comparedPixels Verified protected pixels. @param completeSource Whether every placed source pixel and its full frame were verified. @returns Stored review retaining Host geometry and pixel evidence separately from model quality. */
export function wallpaperPreservedReview(quality: z.infer<typeof wallpaperPreservedQualitySchema> | z.infer<ReturnType<typeof wallpaperPreservedInventorySchema>>, plan: WallpaperPlan, source: { id: string; digest: string; width: number; height: number }, output: { id: string; digest: string }, settings: WallpaperSettings, comparedPixels: number, completeSource = false) {
  const geometry = wallpaperGeometry(source, plan, settings)
  const protection = { result: geometry.checks.length ? 'violated' as const : 'satisfied' as const, reason: geometry.checks.length ? geometry.checks.join('; ') : 'Frozen source regions fit the measured safety bounds; protected source pixels are unchanged.' }
  const preserved = { result: 'satisfied' as const, reason: 'Protected content equals the uniformly placed original in every compared pixel.' }
  const checks = { ...quality.checks }, findings = [...quality.issues]
  if (quality.version === 'wallpaper-preserved-quality-v2') {
    const addFinding = (check: 'subject' | 'background', reason: string, rect: z.infer<typeof wallpaperObjectRoleSchema>['rect'], result: 'violated' | 'unknown') => {
      findings.push({ check, reason, rect })
      if (checks[check].result === 'satisfied' || result === 'violated') checks[check] = { result, reason }
    }
    for (const row of quality.inventory) {
      const extra = row.instances[1]
      if (extra) addFinding('background', `Extra instance of ${row.entityId}: ${row.reason}`, extra, 'violated')
      else if (row.status !== 'retained' || row.instances.length !== 1) addFinding('subject', `Source entity ${row.entityId} is ${row.status}: ${row.reason}`, row.instances[0] ?? { x: 0, y: 0, width: 1, height: 1 }, row.status === 'uncertain' ? 'unknown' : 'violated')
    }
    for (const row of quality.newForeground) addFinding('background', `New foreground ${row.name}: ${row.reason}`, row.rect, 'violated')
    for (const row of quality.transitions) if (row.result !== 'satisfied') addFinding('background', `Source ${row.edge} junction ${row.result}: ${row.reason}`, { x: Math.max(0, geometry.target.left / settings.width - 0.02), y: Math.max(0, geometry.target.top / settings.height - 0.02), width: Math.min(1 - Math.max(0, geometry.target.left / settings.width - 0.02), geometry.target.width / settings.width + 0.04), height: Math.min(1 - Math.max(0, geometry.target.top / settings.height - 0.02), geometry.target.height / settings.height + 0.04) }, row.result)
  }
  const issues = findings.slice(0, 32).map(issue => ({ kind: issue.check === 'background' ? 'background' as const : issue.check === 'clock' || issue.check === 'readability' ? 'readability' as const : issue.check === 'style' ? 'style' as const : 'preservation' as const, check: issue.check, code: 'other' as const, reason: issue.reason, evidence: { kind: issue.check === 'background' ? 'background-artifact' as const : issue.check === 'style' ? 'style-change' as const : 'detail-loss' as const, entityIds: [], imageVersionId: output.id, outputRect: issue.rect } }))
  const correspondence = quality.version === 'wallpaper-preserved-quality-v2' && (quality.newForeground.length || quality.inventory.some(row => row.instances.length !== 1 || row.status !== 'retained')) ? { result: quality.inventory.some(row => row.status === 'uncertain') ? 'unknown' as const : 'violated' as const, reason: 'Final object inventory does not match the source; preserved pixels alone cannot qualify the complete output.' } : preserved
  const sourceDefect = checks.subject.result === 'violated' || checks.clarity.result === 'violated' || quality.version === 'wallpaper-preserved-quality-v2' && quality.inventory.some(row => row.status === 'missing' || row.status === 'changed' || !row.instances.length)
  const unresolved = checks.subject.result === 'unknown' || checks.clarity.result === 'unknown' || quality.version === 'wallpaper-preserved-quality-v2' && quality.inventory.some(row => row.status === 'uncertain')
  const repairTarget = quality.version === 'wallpaper-preserved-quality-v2' ? sourceDefect ? 'source' : unresolved || Object.values(checks).some(check => check.result === 'unknown') && !Object.values(checks).some(check => check.result === 'violated') ? 'evidence' : 'background' : undefined
  return wallpaperStoredSourceReviewV4Schema.parse({ reviewVersion: 'wallpaper-review-source-v4', subject: plan.subject, checks: { ...checks, protection }, styleResults: [], issues, ...(quality.version === 'wallpaper-preserved-quality-v2' ? { backgroundBrief: quality.backgroundBrief, preservationRepairTarget: repairTarget } : {}),
    subjectIntegrity: { mode: plan.mode, source: { extent: 'complete', reason: plan.sourceAssessment?.reason, imageVersionId: source.id }, output: { extent: checks.subject.result === 'satisfied' ? 'complete' : 'unknown', reason: checks.subject.reason, imageVersionId: output.id }, task: checks.subject },
    sourceRepair: { result: 'satisfied', reason: 'This healthy-source route does not generate subject repairs.' }, sourceCorrespondence: correspondence,
    actualLayout: { imageVersionId: output.id, regions: wallpaperPositionedLayout(wallpaperModelPlan(plan), source, settings).positionedRegions.map(region => ({ ...region, scope: 'core' })) },
    layoutChecks: geometry.checks, layoutWarnings: [], modelProtectionCheck: { result: 'satisfied', reason: 'Geometry is Host-owned; the model reviews final visual quality only.' }, modelIssues: issues,
    preservationProof: { version: completeSource ? 'source-pixels-v2' : 'source-pixels-v1', sourceImageVersionId: source.id, sourceDigest: source.digest, outputImageVersionId: output.id, outputDigest: output.digest, comparedPixels, changedPixels: 0, ...(completeSource ? { sourceRect: geometry.target } : {}) },
  })
}
