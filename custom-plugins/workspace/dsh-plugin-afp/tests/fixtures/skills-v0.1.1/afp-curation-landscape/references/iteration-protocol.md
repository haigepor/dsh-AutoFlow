# 风景壁纸迭代协议

## 目标

`AutoFlow_风景` 只收录可直接作为壁纸使用的完整环境画面。文字召回只负责发现候选；是否通过只能由预览像素、风景构图硬规则和本地去重决定。

## 搜索迭代

1. 先从山地冰川峡湾、海岸水域、冰雪荒漠、森林国家公园、受地貌约束的日出日落、海外著名景点、城市全景和风景摄影师署名等结构化窄来源分组召回；发现预算按自然 70%、城市 20%、摄影师/Topshots 10% 组织，不把所有地点塞进一条巨大 OR。
2. 景点来源优先使用非中国的高辨识度自然地貌和国家公园名称；摄影师来源只用于发现风格稳定的风景候选，不得绕过像素级构图门槛。
3. 每个新来源先做最小只读 AFP 请求。字段优先顺序为 `creator="..." AND caption=(...)`、`country=ISO3 AND caption=(...)`、`city="..." AND caption=(...)`、`all_keywords=...`、`caption=(...)`；任一字段无结果或失败才回退下一层。FAR 固定排除 `China`、`Chinese`、香港、澳门和台湾；AFP 无法稳定解析的长地点别名 `NOT` 条件不反复拼接，转入 `metadataExclusions`。
4. 每批最多向视觉模型提交 100 个全新候选。各变体必须按 FAR `hasMore + cursor(direction: next)` 交错翻页；每个 variant 将 `queryHash`、`cursor`、`pagesFetched`、`exhausted`、`stoppedBecause`、`seenCursors`、`fallbackSucceeded` 保存到 search checkpoint。`max-pages-reached` 只表示本次进程预算用尽，下一批必须从 checkpoint cursor 继续，禁止重新从首页召回同一分页。
5. 同一图片 ID、其他收藏夹已收藏 ID、前序类别已保留 ID、历史候选/历史决策/元数据拒绝/重复排除文件中的 ID、同一批跨 query variant 重复 ID，以及历史规范化标题簇，均在视觉前排除。报告必须单列 `duplicateExclusionCount`，不能把这些排除并入 metadata reject。
6. 同一规范化标题的候选上限必须由真实图集污染决定；不要仅为了追求数量放宽重复限制。每批结束保存 `knownIds`、`titleKeys`、`pending` 与 `deferred`，使新进程优先消费已经翻页但尚未送审的候选，再从保存 cursor 继续，不会丢失或回到已经消费的图片。

## 壁纸构图判定

必须同时满足：

- `presentation=wallpaper`，且 `primaryFocus` 是 `natural-landscape` 或 `city-panorama`；`sceneType` 必须对应 `natural-scenery` 或 `open-city-panorama`。
- 环境主体覆盖至少 75%，并具备 `spatialDepth=strong`。
- `frameOrientation` 只接受横幅或全景；两者标记 `wallpaperFit=desktop`。竖幅/方幅即使风景主体清晰，也不进入本桌面风景收藏，避免与横幅审美目标混杂。所有通过画幅都必须包含 `layered-depth`，且 `subjectClarity=clear`。主要水平结构优先 `horizonPlacement=centered`；`off-center-balanced` 只在同时包含 `clear-anchor` 与 `balanced-off-center` 时可通过，`off-center-unbalanced` 必须拒绝；平静感为高或中，人物不主导，审美分至少 4。
- 船只只能是 `none|incidental`，人群只能是 `none|sparse`，`editorialContext` 必须为 `none`。城市全景还必须 `urbanOpenness=open`、`cityAnchorType != none`、`visualClutter=low`；自然场景为 `not-applicable`。
- 没有源图内文字、Logo、边框、拼贴或主导性的前景干扰。
- `compositeImage=false`、`anchorStrength=strong|medium`、`negativeSpaceDominance=balanced`、`artificialLightRole=none|incidental`、`industrialDocumentary=false`；城市/海岸/地形基础设施角色不得为 `prominent|dominant`。
- 自然风景允许山、湖、海岸、冰川、森林、沙漠、瀑布和天空等完整环境；城市风景只允许广阔全景，不允许单栋建筑或街头纪实。
- 元数据中存在中国、香港、澳门、台湾或维护的地点别名时必须拒绝；只有画面存在直接且高度特异的地域视觉证据时才可在视觉层标为 `evident|likely` 并拒绝，不能从人物外貌、模糊亚洲风格或文字元数据推断。

必须拒绝：

- 人像、人群、活动、人物或车辆成为主构图。
- 单条道路、交通、单栋建筑、单个物体、产品、近景花草或动物。
- 洪水、野火、风暴、事故等以新闻事件为主体的画面。
- 码头、游艇港、渡船、船坞、密集船只、工作水岸；河岸日常活动、迁移/救援/仪式、海滩成团人群；屋顶和地标挤满画面且没有天空、水面、地貌留白的城市建筑记录；以及大面积空天空/水面/地面使主体无法从缩略图清晰读出、构图明显上重或下重的画面。
- 源图自身含有标题、海报、信息图、拼贴、Logo 或边框。

AFP 水印、版权条、图片 ID、查看器控件和页面 UI 都是预览叠层，必须忽略。

## 回归纪律

每发现一类误判，先把它标为以下之一，再只改一个原因：

- `search-pollution`：新增或收紧一个查询变体、正向证据或元数据排除词。
- `composition-false-positive`：增强视觉提示词和本地风景构图校验。优先将新的误判沉淀为 `sceneType`、`vesselRole`、`crowdScale`、`editorialContext`、`urbanOpenness`、`subjectClarity`、`horizonPlacement`、`anchorStrength`、`negativeSpaceDominance`、`artificialLightRole`、`cityInfrastructureRole`、`coastalStructureRole` 或 `terrainInfrastructureRole`，避免仅以低审美分等模糊字段补丁。
- `duplicate-leak`：补充历史决策、跨收藏夹或最终写入去重测试。
- `source-observability`：补充来源字段、query hash、字段回退、分页和来源通过率测试；不得把摄影师/景点名称直接升级为视觉通过。
- `provider-preview-failure`：补充失败不保留、重试或报告统计测试。

修改后至少运行对应的核心单测、AFP 插件聚焦测试 和六个 Skill 的 UTF-8 校验。验收报告必须同时给出 raw recall、metadata reject、duplicate exclusion、visual kept/rejected、pages fetched 和 source-level metrics。没有 dry-run 通过和用户明确授权，不得执行远端 `afp_apply`。

## 2026-08-13 来源扩展复测记录

- v9：24 张候选、5 张通过，人工复核 5/5；证实海外景点和摄影师方向有效，同时发现展览、人物档案及摄影师同名体育语境污染。
- v10：收紧摄影师查询并补元数据排除后，24 张候选、6 张通过，人工高分辨率复核 6/6；摄影师来源贡献 3/6，海外景点来源贡献 1/6，全部通过项审美分为 5。
- Stage 01-03（2026-08-14）：远端清空后完成 335 张视觉复核，初步保留 88 张；人工联系表又剔除中央人物、小船锚点、海上风机带和同一摄影系列近重复，最终可写入 35 张。新增 `hiker|climber|wind turbine|kefm` 元数据排除，并将最终收藏审美门槛收紧为 5/5。
- Stage 04（2026-08-14）：125 张视觉复核保留 50 张，人工按地点/摄影系列压缩 20 张，最终写入 30 张；累计远端 98 张。下一阶段减少城市 skyline 过量召回，增加 Dolomites、Lake Bled、Plitvice Lakes、Aoraki、Fiordland、Kilimanjaro 等自然地貌来源。
- Stage 05-08（2026-08-14）：新增自然地貌查询后累计远端达到 221 张；Stage 08 从 297 张视觉候选中人工保留 35 张，并修复 `Jiangxi|Huichang` 中国地域别名泄漏。地点系列仍需通过联系表压缩，不能仅靠标题去重。
- 后续继续扩充地点或摄影师时，必须先以独立窄查询做最小只读验证，再用新批次检查通过率和污染类型；不得因为著名署名或地点名称跳过像素级壁纸门槛。
- 当视觉接口响应时间较长时，优先采用“单批即落盘”策略：`maxBatches=1`，每批完成后立即保存 candidates、decisions 和 report；阶段超时后先检查后台 Node 进程和已落盘文件，禁止把超时误判为无结果并重复消耗视觉额度。
- 联系表人工序号必须映射到模型通过项序号或直接映射候选 ID，不能把通过项序号误套到完整决策数组；写入前必须用 dry-run 核对 `plannedAddCount` 与人工保留数量。
- 远端目标接近上限时，按缺口精确设置 `--limit-per-category`，并在 `afp_apply` 后再次读取 Selection 详情，直到 `existingCount=500`。
