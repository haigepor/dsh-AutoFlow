/** Source observations retain framing and appearance independently of later editing permission. */
import { z } from 'zod'

/** The source-framing wire format admits at most four native evidence crops per inspection. */
export const wallpaperSourceFramingMaxDetails = 4

/** Source-only inspection can correct measured boxes but never grants permission to extend anatomy. */
export const wallpaperSourceFramingPrompt = {
  version: 'wallpaper-source-framing-v1' as const,
  text: `只复核完整原图和本次真实局部裁片，不编辑、不生图。按已有entityId逐一核对实际完整可见范围rect、真正被原图画框截断的sourceEdges，以及人物或动物的视觉核心layoutFocus。所有坐标均为完整原图的归一化坐标；局部裁片的坐标映射由请求提供，不能把裁片边缘当成原图画框。
区分手臂或衣袖真实出框、正常遮挡与背景颜料晕染。人物焦点须包含完整可见头部，以及表现当前动作的持握及空手手势，范围到可见指尖。乐器等独立实体各自保留完整可见框。不能为凑出可行布局而缩框、隐去部位、改姿势、补画肢体或取消真实截断。
result为confirmed、corrected或uncertain。每个受保护实体恰好一个finding。用完整原图核对取景，evidenceImageVersionIds填写至少一个本次真实局部裁片的ID，reason简述像素依据。rect记录完整可见内容。只为已有局部或特写取景记录layoutFocus，焦点须在自身rect内；完整或不确定取景省略layoutFocus。看不清时填uncertain并说明原因，不猜测。保留原有身份、数量、角色、媒介、要求和关系，几何可行性由Host计算。`,
}

/** Source evidence needed before a generated layout can adapt an outer detail. */
export const wallpaperPeripheralFramingInspectionInstructions = '每个finding可用peripheralEdges记录已由本次真实边缘裁片确认、且不触及主体视觉核心的外缘截断。每项填写edge、detail和实际覆盖该方向画框及被截部位的cropImageVersionId，并在evidenceImageVersionIds引用同一裁片。只允许非动作关键的枝叶末梢foliage-tip、衣袖或下摆的织物外沿clothing-edge、细长的现有天线末段thin-appendage、同一太阳翼内已经出现的外围重复板面repeat-structure-edge。原图没有真正触边时修正rect与sourceEdges，不把近边误写成截断。脸、手、动作相关肢体、琴及琴弓、汽车任一可见结构、主体舱段与环、以及任何关键结构都不得记录为peripheralEdges。人物底边的半身原取景应继续留在成品边缘，无把握时不授权该边。真实截断仍留在sourceEdges。'

/** Only new tasks require an explicit assessment of every source entity's outer framing. */
export const wallpaperPeripheralFrameAdaptationSchema = z.enum(['verified-v1', 'verified-v2', 'verified-v3', 'verified-v4'])
/** Frozen version of the source framing assessment contract. */
export type WallpaperPeripheralFrameAdaptation = z.infer<typeof wallpaperPeripheralFrameAdaptationSchema>

/** Only new admitted tasks use the required per-edge assessment with a separate core for each partial primary. */
export const wallpaperSourceFramingPromptV2 = {
  version: 'wallpaper-source-framing-v1' as const,
  text: `只复核完整原图和本次真实局部裁片，不编辑、不生图。result为confirmed、corrected或uncertain。每个受保护entityId恰好填写一个finding。保留实体、角色、媒介、要求和关系，在完整原图的归一化坐标中实测rect、sourceEdges及适用的layoutFocus。几何可行性由Host计算。reason简述可见像素依据，evidenceImageVersionIds至少引用一个本次真实局部裁片。
按完整原图的上下左右四条真实画框逐边核对。edgeCrops记录每张局部图在原图中的归一化sourceRect及覆盖的frameEdges，只能用实际包含该条原图画框及接触部位的局部图确认截断。留出连续背景的一边不记截断，例如太阳翼伸出右侧而底边仍是一带地球或星空，只记录右侧。局部图外缘和靠近原图边缘都不足以证明截断。把误报的方向从sourceEdges移除并按可见外缘校正rect。
所有已确认partial或close-up的普通primary都要量layoutFocus，涵盖人物、动物、植物、器物与大型结构。它是主要可见体量和关键动作的紧凑实测框，rect保留整个可见实体。空间站焦点覆盖主环、舱段、主体枢纽及其关键连接，远端重复太阳翼板面和细天线末梢由完整rect保留；不要只为满足必填项把整幅图或包含外围翼板的完整总装框填成焦点。有人物时仍量全头部与表达动作、持握手到可见指尖。只有可见证据确实不能区分焦点时报告uncertain。
每个finding必须明确填写peripheralEdges数组。逐边评估真实截断是主角或关键部件的缺失，还是仍可在不改变可见范围和身份的情况下自然收束的外缘。对于后者逐项填写edge、detail和实际覆盖该原图画框与接触部位的cropImageVersionId，并在evidenceImageVersionIds引用同一裁片。无符合项填[]。允许非动作关键的枝叶末梢foliage-tip、仅衣料触边而手臂轮廓和可见动作仍完整的织物外沿clothing-edge、现有细天线末段thin-appendage、同一太阳翼内已经出现的外围重复板面repeat-structure-edge。不得把脸、手、动作相关肢体、琴及琴弓、汽车部件、主环与主体舱段或其他关键结构作为可收束外缘。人物底边的半身取景保持原有实裁。真实裁切仍如实保留在sourceEdges。`,
}

/** A first observation can call the intact core whole even when the surrounding assembly is visibly cropped. */
export const wallpaperSourceFramingPromptV3 = {
  ...wallpaperSourceFramingPromptV2,
  text: `${wallpaperSourceFramingPromptV2.text}
首轮标为whole且visibility为frame-cropped的普通primary也须复核。若全部实际被裁断的方向均由本次原生裁片确认只涉及非关键外缘，且裁片与全图能区分完整的可见核心，仍应同时填写layoutFocus和全部peripheralEdges。layoutFocus贴合未被裁断的核心且在完整rect内，保持与所有已证实外缘的距离。保留完整rect、被裁的方向和结构关系，Host据此修正取景分类。例：轨道设施保留主环、舱段、枢纽和必需连接作为核心，已证实触画框的太阳翼重复板面仍计入整站完整可见范围。若裁中核心或关键部位、任一方向无可靠裁片，或原取景完整、为汽车或独立关键部件，继续使用完整范围，不提供缩小的焦点。`,
}

/** Every true source-frame cut receives its own classification from inspected original pixels. */
export const wallpaperSourceFramingPromptV4 = {
  version: 'wallpaper-source-framing-v1' as const,
  text: `只复核完整原图和本次真实局部裁片。保留已给出的实体、角色、媒介、要求和关系，不能编辑或生成。result为confirmed、corrected或uncertain。每个受保护entityId恰好填写一个finding，rect与layoutFocus使用完整原图归一化坐标。evidenceImageVersionIds至少引用一个本次实际裁片，reason简述像素依据。
先对照四条真实画框修正sourceEdges，只保留该实体的真实画框截断。裁片边缘或近边背景不足以证明原图截断。edgeCrops列出每张裁片在原图中的坐标及包含的真实画框方向。
逐个sourceEdges方向填写一行frameEdgeAssessments，不能留空或漏评。若裁片清楚显示接触处只有非关键外缘，且核对完整原图后主体核心与关键动作完整可辨，选择peripheral，填写命中的edge、detail及cropImageVersionId，并在evidenceImageVersionIds引用同一裁片。允许的detail为非关键枝叶末梢foliage-tip、织物边沿clothing-edge、现有细天线末端thin-appendage、同一太阳翼的外围重复板面repeat-structure-edge。不要因同一主体另一边必须保持裁切，就把本边一起保留。例如侧边只切到衣袖外层布料，头、手及动作轮廓仍完整时，单独把侧边记为peripheral；有意的下方半身取景记keep-contact。含脸、手、动作相关肢体、乐器、汽车结构、主环或主体舱段等关键内容的接触应填keep-contact。裁片不足以辨认接触内容时填uncertain，继续保留该原图裁切。没有真实截断的实体才填[]。
普通primary的partial或close-up必须量layoutFocus，覆盖该实体有意义的完整头部、动作与主体结构，不能将同一实体的核心缩短，也不能把独立乐器、陪衬或空白并入人物核心。若原先标whole却frame-cropped，且每条实际截断均有peripheral裁片证据，则在保留完整rect及sourceEdges的同时量出里面未被截断的可见核心，并让焦点与所有已确认外缘有距离。例如大型轨道设施的核心包含主环、舱段、枢纽与必需连接，远端重复翼板由完整rect保留。任何一边仍须保留或无法证实、普通取景完整、汽车或单列关键部件时，继续使用其完整范围。保持原有可见事实，不补画未见部位，不用放大或缩框来规避几何要求。`,
}

/** Observed visual medium; a photograph of a sculpture remains distinct from a living portrait. */
export const wallpaperSourceMediumSchema = z.enum(['photograph', 'illustration', 'painting', 'three-dimensional', 'graphic', 'mixed', 'uncertain'])
/** Medium reported from source pixels rather than inferred from the task name. */
export type WallpaperSourceMedium = z.infer<typeof wallpaperSourceMediumSchema>

/** Use the same physical subject boundary for source and output geometry, independently of appearance checks. */
export const wallpaperCoreMeasurementInstructions = '原图规划、原图重测和成品复审为同一实体使用相同的实体边界。普通主体量贴合其主要可见体量的最小矩形。相接、承托或盛装只是关系：例如糕点与盛盘、雕像与独立底座，按独立实体区分，不能把盛盘或底座的外边当作主角边缘。独立物件确实承担共同焦点才给它单独的primary身份与框。饮具、器皿或底座自身是主角的一部分时，应量入其固有结构。主体外伸的细链、细带、吸管梢、毛梢单独作为外围观察，主体本体和不可替代动作部位保留各自完整轮廓。汽车一律量完整可见车身和部件。主框外仍可见的结构、承托、遮挡关系继续参加保真复审。'

/** Complete intrinsic contour used by whole-subject source and output measurements. */
export const wallpaperPrimaryMeasurementInstructions = '原图规划、原图重测和成品复审为同一实体使用相同的实体边界。沿每个主体可见轮廓追到上下左右最远端，rect包络全部固有结构。花束由花头、相连的茎和绿叶组成；狗量到尾梢，乐器量到琴头，壶量到壶嘴和把手，车辆量到两端保险杠的外侧镀铬边。相接、承托或盛装只是关系：例如糕点与盛盘、雕像与独立底座，按独立实体区分，不能把盛盘或底座的外边当作主角边缘。独立物件确实承担共同焦点才给它单独的primary身份与框。饮具、器皿或底座自身是主角的一部分时，应量入其固有结构。另行记录的可拆装饰细链、细带或吸管可作外围观察；枝叶、尾巴和车件均随本体测量，主体本体和不可替代动作部位保留各自完整轮廓。汽车一律量完整可见车身和部件。主框外仍可见的结构、承托、遮挡关系继续参加保真复审。'

/** Distinguish independent subjects from visible props before freezing their geometry. */
export const wallpaperSubjectPresentationInstructions = `先辨认画面实际展示或叙述的对象，再评估醒目的陈设。对每个暂列primary的实体填写presentationAssessments。判断时分别设想拿掉该物件和拿掉它的邻近主角：拿掉该物件后，若画面仍明确在展示或叙述同一主题，只少了装饰风格、视觉平衡、陈设层次或边缘框景，它属于styling。填写其服务的独立主角supportsEntityId，并用原图像素说明陈设关系和省去该物件时仍成立的主题。位于另一件家具或产品之上、与另一个焦点颜色对比、形成左右视觉高点或远近呼应，均不能单独证明同为主角。
真正独立陈列的产品、主题明确的花艺或器皿、并列人物及共同承担动作或身份的主体均填independent。以原图中的展示方式、独立身份或叙事关系说明何以缺少它就改变实际主题。无把握时保留primary并填independent，不因安全区、体量或便于构图而降级。汽车以及已经冻结的主角保留independent。已明确标为supporting的独立装饰无需再填。Host只为真正主角和关键部位形成安全区保护框，保留陪衬的外观、相对位置和承托关系；subject、priorities与editPrompt按此区分主题和陪衬，不能要求放大或挪动陪衬来满足主体比例。`

const statement = z.string().trim().min(1).max(600)
const focus = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) })
  .refine(value => value.x + value.width <= 1 && value.y + value.height <= 1, 'A layout focus must remain inside the complete source image.')
const accessory = { visibleAccessoryExtent: focus.optional().describe('Tight source-image bounds of a visually clear integral narrow attachment outside the main body, including its visible ends or loop. This constrains only the complete output frame. Exclude props, decoration, supports and unknown off-frame portions.') }

const sourceFields = {
  visibility: z.enum(['visible', 'occluded', 'frame-cropped', 'damaged', 'uncertain']),
  preserve: z.array(statement).min(1).max(8),
  relationships: z.array(statement).max(6),
}
const completeView = z.strictObject({ ...sourceFields, framing: z.enum(['whole', 'uncertain']), layoutFocus: z.never().optional() })
const partialView = z.strictObject({ ...sourceFields, framing: z.enum(['partial', 'close-up']), layoutFocus: focus.optional().describe('Source-image coordinates of the meaningful visual core, including the visible head and any action-defining grasp or free-hand gesture. Stay inside the complete entity, which is still required for content review.') })

/** Per-object source facts never grant permission to invent hidden anatomy, text or structure. Historical partial views may omit their focus. */
export const wallpaperSourceIntentSchema = z.strictObject({ ...sourceFields, ...accessory, framing: z.enum(['whole', 'partial', 'close-up', 'uncertain']), layoutFocus: focus.optional() }).superRefine((value, ctx) => {
  if (value.layoutFocus && value.framing !== 'partial' && value.framing !== 'close-up') ctx.addIssue({ code: 'custom', path: ['layoutFocus'], message: 'Only a confirmed partial or close-up source view may provide a layout focus.' })
})
/** Live observation exposes the permitted focus fields directly in the model-visible schema. */
export const wallpaperObservedSourceIntentSchema = z.discriminatedUnion('framing', [completeView, partialView])
/** Initial observation requires a focus for confirmed partial primaries and forbids it for whole or uncertain views in the transmitted schema. */
export const wallpaperPrimarySourceIntentSchema = z.discriminatedUnion('framing', [completeView, partialView.required({ layoutFocus: true })])
/** Current ordinary primaries may separately preserve a clear integral attachment against new frame clipping. */
export const wallpaperPrimarySourceIntentWithAccessorySchema = z.discriminatedUnion('framing', [completeView.extend(accessory), partialView.extend(accessory).required({ layoutFocus: true })])
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
preserve写1至8条本图必须保留的可见事实，具体到面部外观、表情、姿态、服装、花纹、产品结构、画法或清楚可读的重要文字；不把看不清的文字、画外身体或背面写成已知事实。relationships写0至6条须保持的持握、拥抱、骑乘、人物与宠物接触、承托、相互位置及遮挡关系。存在表达手势时，写清手势对应哪只手、可见指尖及动作方向，让复审辨认同一手势。原有共同主角的身份、数量和关系不得因构图而改变。
人物和动物的partial或close-up保留原有显露范围，不为完整性或扩图补造画外腿脚、手臂、尾巴、背面，也不解除原有遮挡。原图本来是全身则保留本来可见的全身结构；不得反过来裁掉主角部位来放大脸。植物、产品与建筑的画外延续也不等于已获修复授权，不补造未知品牌、文字、关键机械结构、特定建筑部件或主体身份细节。
rect按任务的主体测量范围包络该实体。除汽车外，每个已确认partial或close-up的primary必须填写sourceIntent.layoutFocus，用完整原图归一化坐标标出该实体内部有意义的视觉核心。人物焦点覆盖完整可见头部、必要持握动作及参与表达的空手手势；检查两手各自在做什么，比如演唱时握话筒之外伸出的表达手势、演讲时指向对象的手势，都要量到可见指尖。自然垂放或仅承重的手无需为布局单列。动物焦点覆盖头部和主要姿态。整块衣裙或原图已经出框的躯干仍通过完整rect参加保真检查；保持全部重要可见内容。关键手持物和不可替代结构保留自己的完整保护范围。汽车始终使用完整车辆框。
layoutFocus不是裁剪框、编辑蒙版或缩小主体记录的办法；不能删除或降级完整主角来使安全区通过。whole和uncertain不得提供焦点框；不能确认有意义焦点时保留uncertain，不猜测通过。
建筑或地标本身承担视觉焦点时，rect量到其可见实体底座和真实外轮廓，排除邻接的地面、植物、天空、投影和倒影。以整体地形、天际线或环境构图为焦点时按场景观察。
焦点只包含当前实体有意义的头肩与关键动作，不把旁边的乐器、另一人物或背景一起包进人物焦点。原图已经被画框截断的末端不必包含在焦点里，但rect仍如实记录全部可见内容，sourceEdges如实保留截断方向；Host将据此保留最终画框裁切，并在安全范围内寻找主体大小。
frame-cropped时根据真实像素在sourceEdges填写全部原有截断方向，特别检查衣袖、手臂与衣裙接触的画框边；边界框是估计值，不能因为rect.x略大于0就漏掉肉眼可见的左侧截断。没有真实接触时不添加方向，正常遮挡仍记录occluded。
有意出框的人物焦点保留完整可见头部、持握与叙事所需的空手动作。已经被画框截断且不承担动作的衣袖、上臂或下摆留在完整rect中，由保真复审单独核对。
editPrompt用2至4句简述本图编辑目标、原有媒介和必须保持的关键视觉特征。不要重复坐标、缩放系数、角色字段、安全区规则或处理流程；保留半身、特写及原有遮挡，不以补造身体或遮盖已有内容来延展背景。
未知身份或未知关键结构在uncertainties中说明具体部位与缺少的像素依据，保持待复核。已确认真实损伤在sourceAssessment和editPrompt说明部位、证据与处理限制，不把已知损伤改写成未知；它仍须遵守冻结编辑权限，不能因写了damaged就无条件补画、重新生图或声称已修复。`

/** Review the source edges verified by the original-pixel inspection. */
export const wallpaperPeripheralFrameReviewInstructions = 'usage.sourceEdgeContinuation.adaptedSourceEdges若非空，仅允许列表指定实体和方向的已确认外缘细节自然收束。对照真实像素核对原有头部、姿态、遮挡、可见肢体与关键结构完整，且此处没有新肢体、机械部件、重复阵列、背景插块、硬边或不自然截断。其余原有取景边仍按原图核对。'

/** Final review checks the original view and visible relations independently of geometric fit. */
export const wallpaperSourceIntentReviewInstructions = `本任务启用原图取景保护。usage.objectPolicy.objectRoles中的sourceIntent及sourceMedium是已冻结的原图取景与保留要求；逐实体对照wallpaper-original和actual-wallpaper真实像素复核，不能把这些要求本身作为通过证据。
主编辑画布的灰色空白，以及安全区规划图的标线、编号和罩色，都不属于成品内容；若实际成品残留这些辅助内容，须记录为可定位的背景或画质缺陷，不能当作原图设计或直接通过。
layoutFocus只观察本实体，四边必须包含在同一实体rect中；手持乐器、另一人物各用独立实体框。sourcePreservation必须是JSON数组（[]），每项含entityId、framing、appearance、relationships；不得返回以0、1、2为键的对象。
actualLayout.regions的rect按同一任务的主体测量范围包络对应实体；原图实体存在sourceIntent.layoutFocus时，在完整成品上逐个找到它包含的同一头部及关键动作，包括未持物的表达手势，并用实际可见外缘量出layoutFocus。框四边核对成品对应像素，特别看发顶和手指是否超边，排除空白和背景。输出坐标须独立观察，不能照抄原图或规划坐标。完整主体框仍独立报告。
建筑或地标主体的底边以成品中可见的实体基座为准，周围地面、植物、投影和倒影继续按场景检查。
完整检查每个主角的可见范围，不只看布局焦点。原图partial、close-up、正常遮挡或有意画框裁切应保留；人物或动物新增画外身体、扩大下半身显露范围、解除遮挡，即使没有多出一个人物或肢体总数看似正常，也属于未经授权的主体变化。原图whole视角本来可见的头、手、足、耳、尾或关键结构不得新被裁掉。
${wallpaperPeripheralFrameReviewInstructions}
逐项核对sourceIntent.preserve和relationships：面部外观、表情、姿态、服装、花纹、持握与接触、共同主角数量和相互位置、重要文字及产品关键结构。保持原图媒介、材质、画法与艺术比例；不能把绘画改成摄影、把玩偶或雕塑改成真人，也不能以“更合理”为由更换原有风格化结构。
sourcePreservation必须对outputSchema指定的每个实体恰好填写一项，entityId沿用冻结身份，framing、appearance、relationships分别给result和简短真实像素reason：framing检查取景及可见范围；appearance检查原有外观、姿态及preserve要求；relationships检查原有持握、接触、遮挡及相对位置。没有关系要求时说明本项无指定关系，不凭空添加关系。sourceStyle单独给result与reason，核对实际原图媒介、材质与画法；这四类结论不能用defects为空、布局合格或同一句通用通过文案代替。
明确违反取景、可见范围或保留关系时必须报告可定位的major subject-damage或style-change，并在对应sourcePreservation或sourceStyle中填写violated；不要把它当作普通背景变化、minor审美差异或只记layout。主体内容符合要求与安全区位置通过分别判断。身份、关键结构或真实损伤是否保留仍无法确认时，相应项填unknown，记录具体uncertainties并保持待复核；原图未知或真损伤不能不经核实与授权就生成新内容，不得把未知直接变成通过，也不得仅因未知自动再次生图。`
