/** A saved reviewer-authored editing brief precedes new image generation, independently of final acceptance. */
import { z } from 'zod'
import { wallpaperRepairInstructions } from './wallpaper-policy.ts'

/** Deployment choices are frozen separately from geometry and final-review settings. */
export const wallpaperPromptPreparationPolicySchema = z.strictObject({ version: z.enum(['style-brief-v1', 'style-brief-v2', 'style-brief-v3']).default('style-brief-v3'), enabled: z.boolean().default(true), reasoningEffort: z.string().min(1).default('highest'), includeOriginalReference: z.boolean().default(true) })

/** The reviewer describes visible artistic details and produces executable editing instructions, without moving the frozen canvas. */
export const wallpaperGenerationBriefOutputSchema = z.strictObject({
  version: z.literal('wallpaper-generation-brief-v1'), sourceImageVersionId: z.string().min(1), canvasImageVersionId: z.string().min(1),
  styleAnchors: z.array(z.string().min(1).max(600)).min(3).max(16), detailAnchors: z.array(z.string().min(1).max(600)).min(3).max(24),
  preserveInstructions: z.string().min(1).max(8000), extensionInstructions: z.string().min(1).max(8000), repairInstructions: z.string().min(1).max(8000),
  negativeInstructions: z.array(z.string().min(1)).min(1).max(24), generationPrompt: z.string().min(80).max(10000),
  clockText: z.strictObject({ evidence: z.enum(['absent', 'original-required-text', 'generated-overlay', 'uncertain']), action: z.enum(['background-only', 'preserve-original-text', 'remove-generated-overlay']), reason: z.string().min(1) }),
}).refine(value => value.clockText.evidence !== 'generated-overlay' || value.clockText.action === 'remove-generated-overlay', 'Generated clock overlays must be removed, not preserved or merely darkened.')

/** Durable authoring progress retains the exact model level and input identity; a saved result is reused after interruption. */
export const wallpaperGenerationBriefSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('running'), requestId: z.string().min(1), reasoningEffort: z.string().min(1) }),
  z.strictObject({ status: z.literal('saved'), requestId: z.string().min(1), reasoningEffort: z.string().min(1), result: wallpaperGenerationBriefOutputSchema }),
])

/** Reviewer instructions preserve artistic technique and specific healthy details while distinguishing background edits from system overlays. */
export const wallpaperGenerationBriefPrompt = {
  version: 'wallpaper-generation-brief-v1' as const,
  text: `你负责在生图之前完成专业图像编辑提示词，不负责宣告成品合格。逐一观察原图、已定位画布和实际失败证据，以原图可见像素为画风与健康细节的依据；规划文本只是建议，不能代替看图。先在结构化字段记录画风和细节，再写完整、可直接执行的generationPrompt，不输出思考过程。
styleAnchors必须具体描述媒介与底材、笔触方向及颗粒、干湿边缘、色阶和色温、局部微对比、纹理密度与前中后景组织。水彩仍然像水彩不足以证明保真：区分纸张纤维与颜料沉积、湿画法晕染、干笔断续、细密叠色和刷痕，禁止用均匀模糊、平滑数码涂抹或另一种高光渲染替换它们。写实图按原图实际毛发、材质、光线和细节判断，不机械套用水彩标准；柔和原生画风不等于失焦，也不要求凭空锐化。
detailAnchors记录必须保留的具体健康细节，例如狐狸沿身体曲线的毛流、耳缘、闭合眼线与胡须，蘑菇的放射菌褶、菌环、白斑形状和遮挡关系；根据实际图片选取，不能把示例当作本图对象。主体、数量和姿态相同并不足够，不能因主体缩小便把精细笔触合并成平滑色块。
区分四个范围：健康原图内容尽量保持；目标画布中的位置与比例服从已冻结规划；扩展区域发展与原作一致的自然场景；有证据的缺陷才按授权编辑或重构。不要重写健康主体来迎合新背景。扩展森林时允许根据原图空间线索延续自然枝干、叶簇、苔藓与景深层次，不把整片新增区域只填成重复的暗绿色雾团；背景有层次不等于每个角落都锐利，不新增与主题竞争的动物、额外共同主体或不合理结构。用户未要求时不凭空制造戏剧性光效。
usage.referenceLayout给出本轮真实参考图和整图安全区坐标。referenceTransformAlreadyApplied=true表示plan.placement已经体现在参考中，不要再次应用该变换。只有layoutCorrectionApplied=true才表示历史复审要求的候选下移或缩小已经执行，此时generationPrompt保持当前参考位置并补缺口，不能再写一次相同位移。纯安全区位置问题不授权重画健康主体，不把布局失败改写成结构或材质损坏。
当usage.objectPolicy.objectRoles存在时，逐一核对原图并沿用冻结的entityId和角色：primary是必须留在内侧安全区且保持视觉占比的主角，critical-part是其不可替代结构，supporting是必须保留外观但可越过内侧安全区的陪衬。不要把整组产品一概称为共同主体，也不要为容纳陪衬而再次缩小已经定位的主角。陪衬若在原图外画框有意裁切，可以在最终外画框自然裁切；若旧断口进入成品内部，须在授权可编辑范围内自然连接或闭合，不能留下悬空平切边。四个分项说明与generationPrompt必须遵守同一角色表。
${wallpaperRepairInstructions}
usage.sourceEdgeContinuation规定本轮可延续的原图边缘及像素余量，usage.plan.truncations给出实际断口名称。允许的自然收口必须在preserveInstructions、extensionInstructions、repairInstructions、negativeInstructions与generationPrompt中保持一致：对已缩入画布内部的瓶盖、刷柄、盘框等断口，明确写出沿现有轴线、弧面或透视短距离延伸，并形成连续、可见、闭合的局部外轮廓。禁止把“不要补出完整瓶盖、盘框、刷柄端头”写成否定要求；应改为“不虚构大块未见背面、额外盘格、品牌标识或新产品”。不得要求把内部断口恢复成原图裁断状态，又要求无平切或无接缝。已授权的整组缩小和留白不属于要撤销的缺陷；历史复审只是待核实证据，不照抄其互斥批评。generationPrompt须汇总各分项的实际执行要求，简洁写明确动作，不重复长篇历史问题。
当原图边缘有花束、枝叶、木纹等有意裁切的陪衬时，说明原图内的形状、模糊程度和焦平面必须尽量保持；在新增画布补足邻接内容，输出一张连续画面。extensionInstructions必须逐条依据灰色缺口紧邻的实际像素写延展内容：顶部邻接柔焦花叶就不能写成“只补木板”，也不能误称没有缺口；只自然延续局部柔焦形状与背景，不补全整束花。generationPrompt与extensionInstructions不得矛盾，须明确要求交界两侧的颜色、纹理、景深和轮廓连续，不出现横向硬接缝、清晰度突变或重复花瓣。输出背景应为不透明画面。
最终交付是干净壁纸背景；系统时钟仅属于另外叠加的模拟层，本次绝不绘制日期、时间、假时钟、界面、边框、保护线或水印。以主体在冻结安全区内、画风细节保真和自然扩图为目标，不为了假设的时钟对比去压暗顶部或改变健康像素。只有usage.settings.processing.clockContrast明确配置时才执行对应的背景亮度要求。clockText必须区分原图真实文字与候选中模型新增的时钟文字；新增时钟属于generated-overlay，必须选remove-generated-overlay。若失败证据或参考候选已有模型新增的时间/日期，repairInstructions与generationPrompt必须明确要求擦除这些新增文字并补回连续自然背景，不能只压暗天空，也不能以“不加文字”替代删除已有文字。原图本来存在且任务要求保留的真实招牌、文字与标识不得误删。
第1张原图用于艺术细节与对象身份，第2张已定位画布决定输出取景和布局；实际发给生图服务时画布始终是第1参考。当前完整画布策略只发送已定位画布，避免未经摆放的原图争夺构图依据；仍须把已观察的原图画风与细节写入提示词。生图服务返回的完整画面是待复审候选，不要求Host在中间回贴原图。提示词中使用角色名而不是混淆图片序号。历史任务如含原始风格参考，它不决定画布比例、不允许裁出后铺满，不复制成第二组主体。不得改变安全区、目标尺寸、累计预算或验收门槛。已知失败用明确编辑动作表达；不能把“对比不足”“有文字污染”“主体缺失”统称为改善质量。生成新增细节不得声称恢复了真实原图信息。`,
}
