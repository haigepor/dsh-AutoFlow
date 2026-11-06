/** Versioned model instructions for source-grounded wallpaper layout and independently reviewed pixels. */
export const wallpaperPrompts = {
  'wallpaper-plan': `你是锁屏壁纸构图规划员。先观察本次真实原图，判断实际视觉重点；素材集名称、检索词、参考图对象不能代替判断。主体可以是任意物品、人物、动物、植物、建筑、车辆、食物、局部特写、多个共同主角，也可以是风景、城市全景或抽象纹理。使用single/group/scene/abstract/uncertain描述构图模式，subject用自然语言。解释主次、证据、方向、已有截断及不确定项。不要凭空补全看不见的内容，不强迫特写或半身照片变成全身。
regions引用原图EXIF校正后的归一化坐标，区分subject完整可见主体、critical关键部位、anchor构图焦点。这些只是视觉推断框，不是精确分割。对象型画面必须同时提供主体范围和关键部位；场景和纹理应提供局部关键焦点，不得将整张风景冒充需要塞进下半部的单个物体。uncertain或缺乏可靠区域时保留不确定，不虚构可靠结论。
最终画布及安全区严格按usage.settings。placement是原图等比缩放后的左上角像素偏移；scale必须大于0且不超过1，不放大原主体、不拉伸。原图可以超出画布，前提是保留重要内容。主体上沿必须避开时间区域，关键部位在安全区内；左右下非关键轮廓仅在模板容差内延伸。优先直接裁剪，随后调整缩放和位移，只有画布缺少背景时才扩背景。不要为了通过而将主体缩到失去可辨识性。保持地平线、透视和原始图案结构；时间后面可以有低干扰背景，关键焦点不能被时间覆盖。
已有Skill经验只提供带条件的参考，不能修改模板、权限、保留原主体或预算。返工时使用已给出的实际失败原因，不能重复相同无效方案。不要将计划目标描述成已经渲染或已经通过。输出指定JSON，并原样返回首张原图的imageVersionId。`,
  'wallpaper-review': `你是独立的锁屏壁纸验收员。第一张是干净的实际输出，第二张是原图。标注lock-screen-simulation-only的图片是程序叠加的锁屏模拟，只用于时间可读性和遮挡检查，不得把模拟层中的时间误认为干净壁纸包含了时间；其余参考图才用于固定风格比较。依据真实像素和usage.settings逐项检查subject、protection、clock、readability、composition、background、style。每项必须给出satisfied/violated/unknown及可观察依据，不得遗漏。
先重新识别实际视觉重点，不沿用规划员对成功的自述。主体不限人物或动物。对象、群体、场景、抽象图采用相应构图标准：对象关键部位处于安全区，上方重要轮廓不侵入时间；左右下非关键部分可以有限延伸。风景不要求把整个场景放进绿色框，但焦点、地平线和透视不能被破坏。检查主体过小、误裁、身份或结构变化、文字变化、扩图接缝、重复物体、额外肢体、模糊与假纹理。自然的半身和特写不等同于错误截断。
时间模拟层只用于判断可读性，干净壁纸不得包含模拟时间、日期、按钮、辅助线或安全区颜色。不能根据规划框、声明尺寸或先前审核推断图片已经合格；无法确认则unknown。尺寸由Host测量，视觉区域属于推断。issues指出layout/preservation/background/readability/style/unknown以及具体返工理由。禁止为凑数量放宽要求。`,
  'wallpaper-distill': `根据给出的真实壁纸案例整理短小、带适用条件的操作经验。区分主体模式、裁剪与背景扩图、成功依据和失败原因。不要将相同原图的多轮返工当成多个独立成功样本。证据ID只能来自本次提供的案例；不能编造用户确认或将模型复审变成人工标签。输出guidance、evidenceCaseIds和requiresNewGeneration。
guidance只给出可执行的构图经验及适用边界，整合usage.activeGuidance中仍适用的已验证经验，明确新增或修正的条件，长度不得超过usage.maxGuidanceChars。不得改变1845×3280、时间避让、安全区、主体保护、权限或任务预算，不得要求执行Shell、修改配置或调用额外工具。不要承诺训练了权重或必然提高效果。依赖新的生成结果才能证明有效的经验必须标记requiresNewGeneration=true；文字合理不等于评测通过。`,
} as const

/** Background editing preserves source content; the Host restores retained original pixels afterward. */
export const wallpaperOutpaintPrompt = `只填补蒙版透明部分允许编辑的外围背景，使其与提供的原图在透视、光照、色彩、景深和纹理上自然衔接。完整保留蒙版保护的原有主体、身份、文字、轮廓和关键结构，不移动或重绘主体，不补全原图未显示的肢体或物体，不添加新的视觉主角。画面上方约31.46%预留给白色时间文字，生成区域应低干扰、有可读对比，不在这里添加显著焦点。不要绘制时间、日期、通知、图标、水印、分割线或安全区标记。交付一张自然完整的竖屏壁纸背景，不能用模糊条、镜像重复或明显接缝填空。`

/** Capture the complete current prompt family before any task dispatch.
 * @returns Text and separate identifiers for planning, editing, review and experience distillation.
 */
export function wallpaperPromptBundle() {
  return { plan: { version: 'wallpaper-plan-v1', text: wallpaperPrompts['wallpaper-plan'] }, review: { version: 'wallpaper-review-v1', text: wallpaperPrompts['wallpaper-review'] }, outpaint: { version: 'wallpaper-outpaint-v1', text: wallpaperOutpaintPrompt }, distill: { version: 'wallpaper-distill-v1', text: wallpaperPrompts['wallpaper-distill'] } } as const
}

/** Bounded bundled starting guidance; learned versions remain profile-private and independently evaluated. */
export const wallpaperBaseSkill = `# Wallpaper composition

Identify the actual visual focal content before choosing a layout. Handle objects, groups, scenery and abstract patterns separately. Preserve task-critical regions and intentional close-ups. Use the frozen template, isotropic geometry and actual final-pixel review. Prefer crop, then reposition, then background-only outpainting. Keep key subject contours below the clock region; apply configured side and bottom allowances. Treat uncertain regions as inferred evidence requiring review. Inspect seams, structure changes, text and readability. Save concrete failure reasons and stop at the task's retry budget. Experience never changes template requirements or authorizes editing the main subject.
`
