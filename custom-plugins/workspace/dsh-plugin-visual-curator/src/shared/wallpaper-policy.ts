/** Task-frozen processing effort and measured peripheral overflow. */
import { z } from 'zod'

/** Pixel evidence for the white date and time; it can reject but never qualify an image by itself. */
export const wallpaperClockContrastPolicySchema = z.strictObject({ version: z.literal('white-clock-v1').default('white-clock-v1'), minimumRatio: z.number().min(1).max(21).default(3), minimumReadableFraction: z.number().gt(0).max(1).default(0.9) })
/** Saved contrast of actual opaque output pixels under the shared clock glyphs. */
export const wallpaperClockContrastSchema = wallpaperClockContrastPolicySchema.extend({ imageVersionId: z.string().min(1), glyphPixels: z.number().int().positive(), readablePixels: z.number().int().nonnegative(), readableFraction: z.number().min(0).max(1), minimumMeasuredRatio: z.number().min(1).max(21) })

/** Frozen authorization distinguishes conservative work from declared generated subject completion. */
export const wallpaperRepairPolicySchema = z.strictObject({
  version: z.literal('subject-repair-v1').default('subject-repair-v1'),
  mode: z.enum(['preserve', 'repair-when-needed']).default('repair-when-needed'),
  maxRepeatedDefects: z.number().int().min(1).max(3).default(2),
})

/** @param settings Frozen task settings; absent policy retains historical source preservation. @returns Whether subject editing is authorized, independently of final qualification. */
export function wallpaperGenerativeRepair(settings: { repairPolicy?: z.infer<typeof wallpaperRepairPolicySchema> | undefined }): boolean {
  return settings.repairPolicy?.mode === 'repair-when-needed'
}

/** Shared instructions apply to planning, generation, routing and independent acceptance. */
export const wallpaperRepairInstructions = `本任务采用usage.settings.repairPolicy（生成请求中为taskPolicy）的冻结策略。repair-when-needed允许针对实际缺陷补画、修改或重构主体，必要时重新生成完整画布；健康部分尽量保留，正常图优先裁剪与保守扩图。保持任务要求、主要对象类型、场景、画风、颜色、合理结构和共同主体；明确身份、文字、标识要求必须保留，不臆造为真实信息。新增细节是生成修复，不是恢复原图真实信息。原图截断或模糊事实照实记录，不能冒称原图完整；授权修复的成品按实际像素独立检查完整性、合理连接、构图、主体安全区、清晰度与背景自然程度。修复范围内必要的结构变化不单独构成原图对应失败，无缺陷内容的无故改变仍失败。原图明确采用肖像特写、半身或局部取景时，按该构图本应呈现的可见主体范围评估完整性；未入镜的腿部或背面不算损坏，不为凑全身而补画。本应入镜的头顶、手指等意外切断仍须如实记录并修复。以原图构图和任务要求为依据，不能把严重车辆缺失或其他真正断缺改称特写来豁免。普通背景、自然景深、无关且本来不可读的小字、正常遮挡与风格柔边不是缺陷。技术错误按技术恢复，不当作图片质量问题。所有预算与累计次数照常生效。`

/** Balanced full-frame review escalates at most one unresolved native-detail request. */
export const wallpaperProcessingSchema = z.strictObject({
  version: z.literal('balanced-v1').default('balanced-v1'),
  reasoningEffort: z.enum(['medium', 'high']).default('medium'),
  criticalReasoningEffort: z.literal('high').default('high'),
  clockContrast: wallpaperClockContrastPolicySchema.optional(),
  maxCanvasAspectCropRatio: z.number().min(0).max(0.1).default(0.04),
  sourceSeam: z.strictObject({ blendPixels: z.number().int().min(1).max(256).default(64), segmentPixels: z.number().int().min(32).max(512).default(256), minimumCrossMean: z.number().min(0).max(255).default(18), minimumRelative: z.number().min(1).max(20).default(4) }).prefault({}),
  maxPeripheralOutsideAreaRatio: z.number().min(0).max(0.02).default(0.005),
  maxTotalOutsideAreaRatio: z.number().min(0).max(0.04).default(0.012),
})

/** Resolve current admission or explicitly requested continuation defaults without introducing a clock contrast requirement.
 * @param configured Current deployment processing choices. @returns Validated current policy, including an explicitly configured historical clock rule when present.
 */
export function resolveWallpaperProcessing(configured?: z.input<typeof wallpaperProcessingSchema>): z.output<typeof wallpaperProcessingSchema> {
  return wallpaperProcessingSchema.parse(configured ?? {})
}
