# 风景审美与地域策略

## 目标

将 `旅游` 收藏夹中可复用的视觉品味转为 `AutoFlow_风景` 的稳定规则，同时排除中国、香港、澳门和台湾来源。

## 审美基线

以 2026-08-11 的全量只读视觉基准为准：直接具备壁纸潜力的参考图共同呈现横幅画面、分层纵深、完整环境、低人物干扰与中高平静感。建筑地标和竖幅旅行摄影可以启发引导线、对称和前景框景，但不能直接降低风景壁纸的横幅与完整环境门槛。

## 海外景点与摄影师来源

为提高自然地貌和城市全景的审美先验，搜索层新增两组发现来源：

- 海外景点：Patagonia、Yosemite、Yellowstone、Banff、Torres del Paine、Milford Sound、Matterhorn、Swiss Alps、Grand Canyon、Iceland、Lofoten Islands、Faroe Islands、Serengeti、Sahara、Great Barrier Reef、Lake Baikal，以及 Wadi Rum、Socotra、Geirangerfjord、Landmannalaugar、Grand Teton、White Sands、Azores、Teide、Uluru、Tongariro、Yakushima、Raja Ampat 等。`Namib Desert`、`Namib` 与 `Sossusvlei` 不再作为风景搜索来源。
- 风景摄影师：Ansel Adams、Galen Rowell、Michael Kenna、David Muench、Art Wolfe、Frans Lanting，以及 Sebastiao Salgado、Peter Lik、Marc Adamus、Max Rive、Chris Burkard、Thomas Heaton。

这些词只提高候选发现质量；摄影师署名、景点名称或旅游标签均不构成通过理由。视觉层仍必须确认完整环境、分层纵深、锚点强度、负空间平衡、无主导活动和无设施纪实。

## 海外来源实测

2026-08-13 的 `landscape-v9` 与 `landscape-v10` 分别复核 24 张全新 Mockup：v9 通过 5 张且人工复核 5/5 合格；在收紧摄影师查询、排除展览/人物/摄影活动/体育同名污染后，v10 通过 6 张且人工高分辨率复核 6/6 合格。v10 的摄影师来源贡献 3/6 个通过项，海外景点来源贡献 1/6，六张的审美分全部为 5。Stage 01-20 随后通过视觉复核、系列压缩、dry-run、apply 和远端回读闭环达到 500 张；Stage 09 联系表序号映射错误已纠正，Stage 10 超时后生成的完整结果也重新压缩并补写。

实测说明摄影师和著名景点适合充当高质量候选入口，但不适合充当审美捷径：同一来源仍会出现人物、展览、竖幅、近景、工业地貌或大面积空天空等不合格画面，因此必须保留当前像素硬门槛和二次确认。

## 网络研究依据

本专项把外部研究视为“选择可观测字段”的依据，而不是用论文取代本地视觉验证：

- Lavdas 和 Schirpke（2020）关于有组织复杂度的实验结果，支持把分层、清晰组织的画面作为审美判断的一部分。
- Li 等（2021）对自然性和视觉开阔度的景观偏好研究，支持记录开阔度和完整环境，而不是只匹配地貌名词。
- Schirpke 等（2023）关于照片云量和景观审美的研究，说明光照和天空状态会改变偏好，因此本流程把平静感作为独立判断而不是固定偏好“晴天”。
- OpenAI 的提示工程建议强调清晰、具体的任务和输出格式；本流程因此让视觉模型返回固定字段，并由本地代码再次校验。

来源：

- https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0235257
- https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2021.629650/full
- https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0288424
- https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api

## 三层地域防线

1. FAR 查询使用短的国家/地区排除词，减少明显地域命中。
2. 元数据预筛使用维护的国家、地区、城市和景点英文别名；命中即拒绝并写入审计原因。
3. 视觉模型只在底层图片存在直接且高度特异的地域线索时标记 `excludedRegionSignal=evident|likely`。`uncertain` 代表没有可靠像素结论，不能被伪装成“非中国”证明。

## 搜索连续性与去重纪律

审美合格不等于可以再次提交：在预览和视觉复核之前，必须排除远端收藏夹已存在的图片 ID、历史候选/视觉决策清单中的图片 ID、当前批次跨来源重复 ID，以及历史候选的规范化标题簇。AFP 搜索必须按每个 query variant 的 `hasMore + cursor(direction: next)` 连续翻页；`search-state.json` 保存 `queryHash`、`cursor`、`pagesFetched`、`exhausted`、`stoppedBecause`、`seenCursors`、`fallbackSucceeded`、`knownIds` 和 `titleKeys`。`max-pages-reached` 只是本轮预算用尽，下一轮从 cursor 恢复；不能每次重新召回同一个首页，再依靠去重掩盖分页失效。报告分别记录 `rawRecall`、`metadataReject`、`duplicateExclusion`、`visualKept`、`visualRejected` 和 `pagesFetched`，不把重复排除冒充为视觉或元数据判断。

## 壁纸审美门槛

- 完整自然环境或广阔城市全景，环境覆盖至少 75%，强空间纵深。
- 横幅或全景画幅，构图信号包含 `layered-depth`。
- 主题必须在缩略图大小即可直接读出，返回 `subjectClarity=clear`；不能因为标题或“画面里有城市/天空”补足主体。
- 地平线、岸线、水线或天际线是主要横向结构时，`horizonPlacement=centered` 是默认安全布局。若偏离中心，只能在明确主体、前中后景分层与视觉配重共同成立时使用 `off-center-balanced`，并同时给出 `clear-anchor`、`balanced-off-center`；大面积空天空/水面/地面造成主体模糊或上重/下重时必须标为 `off-center-unbalanced` 并拒绝。
- 平静感为高或中且 `visualBalance=balanced`，人物不能主导；清晰可辨的中央剪影、前景人物、摆拍或互动人物即使占比不大，也属于人物主导。自然风景不能被建筑主导。平静感只描述观看负荷，不能替代主体、锚点或视觉平衡。
- 画幅不再作为单一审美拒绝条件：横幅/全景标记为 `wallpaperFit=desktop`；竖幅或方幅只要其余像素门槛通过，标记为 `wallpaperFit=smart-crop`，保留用于移动端壁纸、锁屏和后续智能横向裁剪。
- 无源图文字、Logo、边框、拼贴和主导性前景干扰，最终收藏审美分必须为 5。
- 可辨识的小船若成为中央或前景构图锚点，`vesselRole` 必须为 `prominent|dominant` 并拒绝；海上风机阵列或能源设施形成重复地平线带时按显著海岸设施拒绝。
- 画面必须先被识别为 `natural-scenery` 或 `open-city-panorama`，而非用“背景里有自然/城市”替代主体判断。港口、密集船只、渡船、工作水岸、日常纪实、人群活动和迁移/救援现场均不属于风景壁纸。
- 城市仅接受有明显开阔留白的城市全景：天空、水面、远山或远景需与天际线共同形成呼吸感，且天际线本身必须清晰可读、承担画面中部的视觉锚点。屋顶、地标、街区纹理或摩天轮挤满画面的高密度城市记录即使清晰，也应拒绝；反过来，只有模糊低对比城市带和大面积空天空的画面也应拒绝。

## 迭代判读

将每一轮失败归为地域泄漏、文本污染、构图不足、审美不足、视觉 Provider 失败或去重泄漏之一。对构图不足，先区分“无明确锚点”“整体失衡”“层次不足”三种原因；只收紧直接对应失败类别的规则，并为该类别增加回归测试；不要为了补齐数量降低审美分或地域排除边界。
