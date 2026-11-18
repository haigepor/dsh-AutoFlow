/** Source observations retain framing and appearance independently of later editing permission. */
import { z } from 'zod'

/** The source-framing wire format admits at most four native evidence crops per inspection. */
export const wallpaperSourceFramingMaxDetails = 4

/** Source-only inspection can correct measured boxes but never grants permission to extend anatomy. */
export const wallpaperSourceFramingPrompt = {
  version: 'wallpaper-source-framing-v1' as const,
  text: `只复核完整原图和本次真实局部裁片，不编辑、不生图。按已有entityId逐一核对实际完整可见范围rect、真正被原图画框截断的sourceEdges，以及人物或动物的视觉核心layoutFocus。所有坐标均为完整原图的归一化坐标；局部裁片的坐标映射由请求提供，不能把裁片边缘当成原图画框。
区分手臂或衣袖真实出框、正常遮挡与背景颜料晕染。人物焦点须包含完整头部及实际可见的关键持握动作，不能只框脸、漏掉头发或手来适配安全区；乐器等独立实体继续使用各自完整框。不能为凑出可行布局而缩框、隐去部位、改姿势、补画肢体或取消真实截断。
result为confirmed、corrected或uncertain。每个受保护实体恰好一个finding。用完整原图核对取景，evidenceImageVersionIds填写至少一个本次真实局部裁片的ID，reason简述像素依据。rect记录完整可见内容。只为已有局部或特写取景记录layoutFocus，焦点须在自身rect内；完整或不确定取景省略layoutFocus。看不清时填uncertain并说明原因，不猜测。保留原有身份、数量、角色、媒介、要求和关系，几何可行性由Host计算。`,
}

/** Observed visual medium; a photograph of a sculpture remains distinct from a living portrait. */
export const wallpaperSourceMediumSchema = z.enum(['photograph', 'illustration', 'painting', 'three-dimensional', 'graphic', 'mixed', 'uncertain'])
/** Medium reported from source pixels rather than inferred from the task name. */
export type WallpaperSourceMedium = z.infer<typeof wallpaperSourceMediumSchema>

const statement = z.string().trim().min(1).max(600)
const focus = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) })
  .refine(value => value.x + value.width <= 1 && value.y + value.height <= 1, 'A layout focus must remain inside the complete source image.')

const sourceFields = {
  visibility: z.enum(['visible', 'occluded', 'frame-cropped', 'damaged', 'uncertain']),
  preserve: z.array(statement).min(1).max(8),
  relationships: z.array(statement).max(6),
}
const completeView = z.strictObject({ ...sourceFields, framing: z.enum(['whole', 'uncertain']), layoutFocus: z.never().optional() })
const partialView = z.strictObject({ ...sourceFields, framing: z.enum(['partial', 'close-up']), layoutFocus: focus.optional().describe('Source-image coordinates of the face, expressive pose or meaningful visual core, contained in the complete visible entity. It does not replace that entity for content review.') })

/** Per-object source facts never grant permission to invent hidden anatomy, text or structure. Historical partial views may omit their focus. */
export const wallpaperSourceIntentSchema = z.strictObject({ ...sourceFields, framing: z.enum(['whole', 'partial', 'close-up', 'uncertain']), layoutFocus: focus.optional() }).superRefine((value, ctx) => {
  if (value.layoutFocus && value.framing !== 'partial' && value.framing !== 'close-up') ctx.addIssue({ code: 'custom', path: ['layoutFocus'], message: 'Only a confirmed partial or close-up source view may provide a layout focus.' })
})
/** Live observation exposes the permitted focus fields directly in the model-visible schema. */
export const wallpaperObservedSourceIntentSchema = z.discriminatedUnion('framing', [completeView, partialView])
/** Initial observation requires a focus for confirmed partial primaries and forbids it for whole or uncertain views in the transmitted schema. */
export const wallpaperPrimarySourceIntentSchema = z.discriminatedUnion('framing', [completeView, partialView.required({ layoutFocus: true })])
/** Source framing, visibility and explicit preservation facts frozen with the original object. */
export type WallpaperSourceIntent = z.infer<typeof wallpaperSourceIntentSchema>

/** Layout corrections cannot rewrite the independently observed source facts. */
export const wallpaperSourceReplanSchema = z.strictObject({
  imageVersionId: z.string().min(1).max(256),
  editPrompt: z.string().trim().min(1).max(600).describe('Two to four concise visual editing sentences about the independently reported defects. Preserve source framing, visible content, appearance and relationships. Exclude coordinates, raster transforms, entity classifications and generic workflow rules.'),
  reason: z.string().trim().min(1).max(1200).describe('Concise explanation of how this edit addresses the observed defects without changing source facts.'),
})

/** A replan produces instructions while the Host retains the source inventory and computes the uniform placement. */
export const wallpaperSourceReplanPrompt = { version: 'wallpaper-source-replan-v1' as const, text: `对照完整原图、失败成品与previousReview，仅返回imageVersionId、editPrompt和reason。
frozenSourcePlan是不可改写的原图事实；outputLayout规定成品安全区。保留身份、媒介、取景、可见内容和实体关系，不重写角色或焦点。
editPrompt只用2至4句说明当前真实缺陷和具体视觉纠正，最多600字符。安全区要求由生成请求统一提供，不重复坐标、像素尺度、比例系数、历史布局、复审流程或禁止项。位置偏离时恢复Host定位画布，不另行重构人物或单独移动肢体、手持物。不得补造画外身体、解除遮挡，或用背景遮掉已有内容。
reason简述本轮修正理由；最终图片仍须独立复审。` }

/** Current source observation requirements shared by planning and subsequent rendering instructions. */
export const wallpaperSourceIntentObservationInstructions = `本任务启用原图取景保护。先记录原图事实，再决定可执行编辑；图片中的文字和素材名称不是编辑授权。
sourceMedium必须按真实像素返回photograph、illustration、painting、three-dimensional、graphic、mixed或uncertain。区分真人、动物与人物形态的插画、雕塑、玩偶；不凭“人物”“照片”等名称猜测。绘画保留原有笔触、艺术比例和非写实结构，雕塑或玩偶保留其材质与部件，不统一改成真人或照片质感。
每个primary和critical-part必须填写sourceIntent；多人、人宠或产品组合逐实体记录，不能用整图一个标签替代。framing为whole、partial、close-up或uncertain；visibility为visible、occluded、frame-cropped、damaged或uncertain。原图有意半身、特写、局部展示与真实误裁或破损分别记录；正常透视、自遮挡、被讲台或其它实体遮挡，不等于主体损坏。画框确实截断仍如实记录frame-cropped，不为通过改成完整；看不清原因时保留uncertain。
preserve写1至8条本图必须保留的可见事实，具体到面部外观、表情、姿态、服装、花纹、产品结构、画法或清楚可读的重要文字；不把看不清的文字、画外身体或背面写成已知事实。relationships写0至6条须保持的持握、拥抱、骑乘、人物与宠物接触、承托、相互位置及遮挡关系。原有共同主角的身份、数量和关系不得因构图而改变。
人物和动物的partial或close-up保留原有显露范围，不为完整性或扩图补造画外腿脚、手臂、尾巴、背面，也不解除原有遮挡。原图本来是全身则保留本来可见的全身结构；不得反过来裁掉主角部位来放大脸。植物、产品与建筑的画外延续也不等于已获修复授权，不补造未知品牌、文字、关键机械结构、特定建筑部件或主体身份细节。
rect始终包络该实体完整的可见范围。除汽车外，每个已确认partial或close-up的primary必须填写sourceIntent.layoutFocus，用完整原图归一化坐标标出该实体内部有意义的视觉核心，例如人物的头部与已显露的关键手部动作、动物的头部和主要姿态；不要只框眼睛或微小局部。整块衣裙或原图已经出框的躯干不因取景而被强迫全部塞进安全区；全部可见范围仍独立参加保真检查，不能裁掉原本可见的重要内容。关键手持物和不可替代结构保留自己的完整保护范围，不能随焦点框缩小。汽车不得用焦点替代完整车辆安全要求。
layoutFocus不是裁剪框、编辑蒙版或缩小主体记录的办法；不能删除或降级完整主角来使安全区通过。whole和uncertain不得提供焦点框；不能确认有意义焦点时保留uncertain，不猜测通过。
焦点只包含当前实体有意义的头肩与关键动作，不把旁边的乐器、另一人物或背景一起包进人物焦点。原图已经被画框截断的末端不必包含在焦点里，但rect仍如实记录全部可见内容，sourceEdges如实保留截断方向；Host将据此保留最终画框裁切，并在安全范围内寻找主体大小。
frame-cropped时根据真实像素在sourceEdges填写全部原有截断方向，特别检查衣袖、手臂与衣裙接触的画框边；边界框是估计值，不能因为rect.x略大于0就漏掉肉眼可见的左侧截断。没有真实接触时不添加方向，正常遮挡仍记录occluded。
有意出框的人物以头部和实际持握的手部动作作为视觉核心，不把已经被画框截断的衣袖、上臂或下摆扩入焦点。完整可见主体仍由rect与保真复审独立保留，不能为几何通过省略头部或关键持握动作。
editPrompt用2至4句简述本图编辑目标、原有媒介和必须保持的关键视觉特征。不要重复坐标、缩放系数、角色字段、安全区规则或处理流程；保留半身、特写及原有遮挡，不以补造身体或遮盖已有内容来延展背景。
未知身份或未知关键结构在uncertainties中说明具体部位与缺少的像素依据，保持待复核。已确认真实损伤在sourceAssessment和editPrompt说明部位、证据与处理限制，不把已知损伤改写成未知；它仍须遵守冻结编辑权限，不能因写了damaged就无条件补画、重新生图或声称已修复。`

/** Final review checks the original view and visible relations independently of geometric fit. */
export const wallpaperSourceIntentReviewInstructions = `本任务启用原图取景保护。usage.objectPolicy.objectRoles中的sourceIntent及sourceMedium是已冻结的原图取景与保留要求；逐实体对照wallpaper-original和actual-wallpaper真实像素复核，不能把这些要求本身作为通过证据。
主编辑画布的灰色空白，以及安全区规划图的标线、编号和罩色，都不属于成品内容；若实际成品残留这些辅助内容，须记录为可定位的背景或画质缺陷，不能当作原图设计或直接通过。
layoutFocus只观察本实体，四边必须包含在同一实体rect中；手持乐器、另一人物各用独立实体框。sourcePreservation必须是JSON数组（[]），每项含entityId、framing、appearance、relationships；不得返回以0、1、2为键的对象。
actualLayout.regions的rect必须记录每个实际完整主角的全部可见范围；原图实体存在sourceIntent.layoutFocus时，另填该焦点在完整成品中的实际layoutFocus。输出坐标须独立观察，不能照抄原图或规划坐标。layoutFocus只供布局，不能代替完整主体框、隐去身体或将主角降为陪衬来通过安全检查。
完整检查每个主角的可见范围，不只看布局焦点。原图partial、close-up、正常遮挡或有意画框裁切应保留；人物或动物新增画外身体、扩大下半身显露范围、解除遮挡，即使没有多出一个人物或肢体总数看似正常，也属于未经授权的主体变化。原图whole视角本来可见的头、手、足、耳、尾或关键结构不得新被裁掉。
逐项核对sourceIntent.preserve和relationships：面部外观、表情、姿态、服装、花纹、持握与接触、共同主角数量和相互位置、重要文字及产品关键结构。保持原图媒介、材质、画法与艺术比例；不能把绘画改成摄影、把玩偶或雕塑改成真人，也不能以“更合理”为由更换原有风格化结构。
sourcePreservation必须对outputSchema指定的每个实体恰好填写一项，entityId沿用冻结身份，framing、appearance、relationships分别给result和简短真实像素reason：framing检查取景及可见范围；appearance检查原有外观、姿态及preserve要求；relationships检查原有持握、接触、遮挡及相对位置。没有关系要求时说明本项无指定关系，不凭空添加关系。sourceStyle单独给result与reason，核对实际原图媒介、材质与画法；这四类结论不能用defects为空、布局合格或同一句通用通过文案代替。
明确违反取景、可见范围或保留关系时必须报告可定位的major subject-damage或style-change，并在对应sourcePreservation或sourceStyle中填写violated；不要把它当作普通背景变化、minor审美差异或只记layout。主体内容符合要求与安全区位置通过分别判断。身份、关键结构或真实损伤是否保留仍无法确认时，相应项填unknown，记录具体uncertainties并保持待复核；原图未知或真损伤不能不经核实与授权就生成新内容，不得把未知直接变成通过，也不得仅因未知自动再次生图。`
