# 视觉复核契约

## 输入

候选清单位于 profile 的 AFP 运行记录。每个候选最少包含 `id`、`guid`、目标类别和 AFP 原始排序位置。

## 处理规则

1. 预览通过 FAR `getPhotosByIds` 的 `mockup` 获取；仅请求 Mockup，不触发购买或下载媒体。调用前必须执行候选 ID、历史 ID、远端已收藏 ID、同批重复 ID 和历史规范化标题簇排除。
2. Mockup 引用和 APICore 签名跳转只用于当前内存请求；任何 `duplicate-exclusion` 项不进入预览和 Provider 队列。
3. Provider 必须返回 JSON：`category`、`confidence`、`keep`、`reason`。
4. 本地规则优先于模型：仅目标类别、`keep=true` 且置信度不低于阈值时才保留；模型必须同时满足专项的主要主体和硬排除判据。
5. 全局默认阈值 `0.80`、并发 `3`、每类上限 `100`；易混淆类别另有更高本地门槛：animals `0.82`、food `0.85`、landscape `0.82`、movie-poster `0.90`、celestial-body-wallpaper `0.92`。
6. 提示词要求模型先判断主构图，再判断类别，最后执行硬排除；不能依据 caption、title、关键词、OCR、文件名或外部知识。动物搜索词中的品种、栖息地、动作、完整身体词和光线只属于召回提示，模型必须从像素确认真实动物、主体占比、身体完整度和纹理清晰度；头部加少量躯干的紧凑特写仍属于局部图，不得按 full-body 通过。动物必须额外返回 `subjectRole`、`bodyCoverage`、`imageClarity`、`graphicContent`、`welfareState`、`environment` 和 `coatColor`；只有 `subjectRole=primary` 才能进入后续硬校验，`secondary`、`background`、`ambiguous` 一律拒绝。并通过完整身体、清晰纹理、健康内容、自然状态、干净自然环境和非黑猫本地硬校验。宇宙恒星球体必须额外返回 `subjectKind`、`subjectCoverage`、`emptyBlackCoverage`、`presentation`、`starFieldDensity` 和 `spaceHardwareRole`；后者只能为 `none`、`secondary` 或 `dominant`，其中 `dominant` 必须由本地规则拒绝。风景必须额外返回 `presentation`、`primaryFocus`、`environmentCoverage`、`spatialDepth`、`foregroundDistraction`、`sourceImageText`、`frameOrientation`、`compositionSignals`、`subjectClarity`、`horizonPlacement`、`visualCalmness`、`visualBalance`、`humanPresence`、`builtEnvironmentRole`、`aestheticScore`、`excludedRegionSignal`、`sceneType`、`vesselRole`、`crowdScale`、`editorialContext`、`urbanOpenness`、`compositeImage`、`anchorStrength`、`negativeSpaceDominance`、`artificialLightRole`、`skylineProminence`、`industrialDocumentary`、`cityInfrastructureRole`、`coastalStructureRole` 和 `terrainInfrastructureRole`，并通过本地壁纸构图校验。
7. AFP 水印、版权条、图片 ID、查看器控件和元数据页面 UI 均为预览叠层，视觉模型必须忽略，只判断底层图片主体；源图内的文字、Logo、边框、拼贴仍按硬排除处理。
8. 宇宙类别仅接受 `presentation=wallpaper`：科学太阳圆盘为 `scientific-observation`、地面银河/流星夜景为 `terrestrial-landscape`、稀疏深场为 `sparse-deep-field`，都必须拒绝。空间站/卫星只有作为次要对象时才可通过。
9. 风景类别仅接受 `presentation=wallpaper`、`primaryFocus=natural-landscape|city-panorama`、`sceneType=natural-scenery|open-city-panorama`、`environmentCoverage >= 0.75`、`spatialDepth=strong`、横幅/全景 `frameOrientation`、含 `layered-depth` 的 `compositionSignals`、`subjectClarity=clear`、`horizonPlacement=centered|off-center-balanced|not-visible`、`visualCalmness=high|medium`、`visualBalance=balanced`、非主导人物及 `aestheticScore = 5`。`centered` 是水平线的默认安全构图；`off-center-balanced` 只有同时含 `clear-anchor` 和 `balanced-off-center` 信号时才可通过；`not-visible` 必须含 `clear-anchor`；`off-center-unbalanced` 必须拒绝。`vesselRole` 只能为 `none|incidental`，`crowdScale` 只能为 `none|sparse`，`editorialContext` 必须为 `none`；城市全景还必须 `urbanOpenness=open`，自然风景必须 `urbanOpenness=not-applicable`。`coastalStructureRole`、`cityInfrastructureRole`、`terrainInfrastructureRole` 只允许 `none|incidental`，`industrialDocumentary` 必须为 false；`compositeImage` 必须为 false，`anchorStrength` 必须为 strong|medium，`negativeSpaceDominance` 必须为 balanced，`artificialLightRole` 只能为 none|incidental，城市 `skylineProminence` 必须为 strong|medium。这样会拒绝码头、渡船、密集船只、岸边生活场景、人群活动、战争/冲突/军事纪实、高密度地标建筑记录，以及大面积空天空/水面但主题模糊、重心失衡、道路/土方切割自然地形或人工灯光主导的伪全景。`excludedRegionSignal=evident|likely` 时本地规则必须拒绝中国、香港、澳门和台湾的明确地域视觉证据；`uncertain` 不得擅自当作地域结论。源图文字、Logo、边框、拼贴与主导性前景必须由本地规则拒绝。

10. 风景首轮通过项必须执行 confirmation pass。确认轮应复查锚点强度、负空间、合成、多重曝光、人工灯光、城市/海岸/地形基础设施与纪实语境；任一轮未通过则最终 `keep=false`。同一次尝试的两轮复用 Mockup。确认阶段中断或请求失败时保存已通过的首轮结果；续跑重新获取预览并只重试确认，不重新调用首轮模型。
11. DSH afp_refresh 在视觉工作前读取命名 Selection，并合并已完成判断和搜索检查点的去重信息；账户目录每次重新读取，目录信息未变且新鲜的成员检查点可复用。同批 ID 和规范化标题簇也必须预先排除。视觉报告必须把 `duplicateExclusionCount` 与 `visualRejectedCount` 分开；ID/标题去重不是视觉拒绝，视觉拒绝也不能覆盖历史去重证据。

## 输出

profile 内 AFP 运行记录按单张保存完成结果、失败代码、尝试次数及待确认阶段；不保存预览字节。判断结果只记录身份、目标类别、预测类别、置信度、保留状态、原因和原始顺序；动物类别额外记录身体完整度、清晰度、图形内容、动物状态、环境和猫毛色排除字段；宇宙类别额外记录构图类型、覆盖率、空黑比例、展示类型和星场密度；风景类别额外记录画幅、构图信号、平静感、整体平衡、人/建筑角色、审美分和地域证据级别。不得记录认证信息、签名 URL、媒体引用、图片 Base64、原始模型请求或响应头。
