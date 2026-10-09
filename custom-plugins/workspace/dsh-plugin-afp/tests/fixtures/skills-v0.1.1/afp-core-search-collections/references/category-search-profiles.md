# 五类图片搜索配置

AFP FAR 是文本召回，不是图像分类器。当前配置不再使用一条“大 OR”查询覆盖全部词，而是为每类拆成多条窄查询，再合并、去重、做可审计的元数据预筛，最后交给 `afp-core-visual-triage` 判断像素主体。

| 类别 | 固定收藏夹 | 查询策略 | 默认候选上限 |
|---|---|---|---:|
| `animals` | `AutoFlow_动物` | 先召回猫狗兔马熊猫、海豚海豹企鹅、大型哺乳动物和舒适鸟类，再召回中性野生动物；蜘蛛、幼虫、蠕虫、蜈蚣、蝎子、蜱虫、螨虫、蟑螂和不适构图在元数据预筛与视觉硬门槛双重排除 | 60 |
| `food` | `AutoFlow_食物` | dish/cuisine/dessert/seafood 等食物本体词；排除配送、工厂、餐厅、政治活动、体育语境 | 60 |
| `landscape` | `AutoFlow_风景` | 结构化来源目录：自然地貌约 70%、城市全景约 20%、摄影师/Topshots 约 10%；每个来源按字段优先 + caption 回退，并记录 source metrics；排除新闻污染及中国、香港、澳门、台湾 | 60 |
| `movie-poster` | `AutoFlow_电影海报` | 只使用 `movie poster`、`film poster` 及其 AND 组合；排除红毯、论坛、影院路人和活动语境 | 60 |
| `celestial-body-wallpaper` | `AutoFlow_宇宙恒星球体` | 行星/月球、太阳日冕/耀斑/日珥、具体行星、星云/星系/彗星/黑洞/密集星场、命名深空对象，以及 Hubble/JWST、超新星、类星体和无标签艺术家宇宙视觉分组召回；最终由视觉规则判断大球体、扩展天体或密集星场 | 60 |

## 关键词设计原则

1. **一个类别多个窄查询**：避免单个 OR 查询被最新事件图集占满；每条查询默认取约 `ceil(60*2/variantCount)` 张，再合并。
2. **正向证据和负向语境分离**：正向词只用于召回，`metadataRequiredAny` 只检查可见 title/caption/实体文本中是否有类别信号，`metadataExclusions` 只剔除已观察到的文字污染。
3. **词边界匹配**：按完整词或短语匹配，避免 `bakery` 命中足球运动员 `Bakery Jatta`、`Milky Way` 命中 `milky white`。
4. **三层去重先于视觉**：Selection 已收藏 ID、历史 candidates/decisions 已见 ID、历史候选规范化标题簇，必须在视觉 Provider 调用前排除；同一批内不同 query variant 的重复图片 ID也必须排除。报告将这些记录为 `duplicateExclusionCount`，不计入 `metadataRejectedCount`。
5. **图集分散**：同一规范化标题最多保留 3 张；`celestial-body-wallpaper` 例外地限制为 1 张，避免同一太阳、同一插画或同一星空图集挤占壁纸收藏。重复或被预筛剔除的候选写入审计清单，不伪装成视觉结论。
6. **连续分页**：每个 query variant 必须使用 `hasMore + cursor(direction: next)` 翻页，并在 `search-state.json` 保存 `queryHash`、`cursor`、`pagesFetched`、`exhausted`、`stoppedBecause`、`seenCursors`、`fallbackSucceeded`，需要时保存 `fallbackSkipped`/`fallbackError`。字段优先无结果/失败只跳过该字段变体，不写入伪终止原因；下一批恢复 cursor；禁止每批重新从同一首页召回再依赖 ID 去重。
7. **视觉交接**：通过预筛的仍标记为 `metadataCandidate`；只有真实 Mockup 视觉复核达到类别门槛后，才允许进入收藏夹计划。
8. **壁纸素材补量**：可召回 `artist impression`、`exoplanet`、`digital illustration` 等宇宙视觉，但不把“插画”本身当作合格证据；保留与否仍取决于无文字/无拼贴的像素级壁纸构图。`Milky Way`、`star trails` 容易召回地景夜拍，不作为默认窄查询主力。
9. **动物舒适度与喜爱度**：优先召回猫、狗、兔、马、熊猫、红熊猫、海豚、海豹、企鹅、大象、长颈鹿、狐狸、考拉、水獭、狮子、老虎、鹿和舒适鸟类；再召回猴子、羊、山羊、牛、河马、犀牛、斑马、鲸鱼、猛禽、鹤、天鹅和火烈鸟。品种查询采用两层召回：`full body`、`whole body` 精确组合用于高质量先验；`side view`、`profile`、`standing profile` 与品种、动作、草地/森林/自然栖息地组合用于扩大召回，最终完整身体仍必须由视觉确认。蜘蛛、狼蛛、蝎子、蜈蚣、马陆、蜱虫、螨虫、寄生虫、蟑螂、毛毛虫、蛆、幼虫、蚯蚓、蠕虫、蚂蟥、蛞蝓，以及密集、交配、捕食、追逐、叼住猎物、混合物种、拥挤群体和前景模糊的画面必须在视觉前元数据预筛并在视觉层再次拒绝。关键词只负责召回与排序，不能替代像素判断；`subjectRole` 必须为 `primary`，`comfortLevel=uncomfortable|unknown`、`interactionState=predation|unknown`、`occlusionLevel=major|unknown`、`groupDensity=dense-group|unknown` 或 `foregroundClarity=mixed|blurred|unknown` 直接拒绝，`appealTier=high` 只用于通过项排序。
10. **风景壁纸专项**：`landscape` 使用结构化海外来源目录。自然地貌来源覆盖山地冰川峡湾、海岸水域、冰雪荒漠、森林国家公园、著名景点和受地貌约束的日出日落；城市来源按城市与国家独立查询；摄影师来源按人独立查询；Topshots 只作为低比例发现源。每个来源优先尝试 `creator`、`country`、`city`、`all_keywords`，字段无结果或失败后回退 `caption`。每个来源保存 `sourceId`、`sourceType`、`fieldMode`、`queryHash`、`rawRecallCount`、`metadataRejectedCount`、`duplicateExclusionCount`、`visualKeptCount`、`visualRejectedCount`、`pagesFetched` 和 `rejectionReasons`。景点来源优先 Patagonia、Yosemite、Yellowstone、Banff、Torres del Paine、Milford Sound、Matterhorn、Swiss Alps、Grand Canyon、Iceland、Lofoten、Serengeti、Sahara、Great Barrier Reef、Wadi Rum、Uluru 等非中国地点；`Namib Desert`、`Namib` 和 `Sossusvlei` 从正向查询来源移除，并在本地元数据预筛中排除；FAR 不接受时不强行追加复杂负向别名。摄影师来源优先 Ansel Adams、Galen Rowell、Michael Kenna、David Muench、Art Wolfe、Frans Lanting、Max Rive、Marc Adamus、Chris Burkard、Thomas Heaton、Peter Lik。摄影师署名只用于发现候选，不能替代像素级审美判断。FAR 查询只保留稳定的 `China`、`Chinese`、香港、澳门、台湾地域排除；复杂排除继续交给本地 `metadataExclusions` 与像素硬规则。标题多样性上限为 1；城市最终还必须具备清晰 `cityAnchorType` 且 `visualClutter=low`；是否是完整壁纸仍由像素级环境覆盖、景深、构图、主题清晰度、水平结构平衡、审美分和地域视觉证据共同决定。

## 真实复测结论

2026-08-14 扩展 Sossusvlei、Wadi Rum、Socotra、Geirangerfjord、Landmannalaugar、Grand Teton、White Sands、Azores、Teide、Uluru、Tongariro、Yakushima、Raja Ampat 等新地点，并同步写入 `metadataRequiredAny`；查询地名若未进入正向证据表，会在视觉前被误过滤。

2026-08-13 的风景专项完成两轮只读复测，均使用 24 张全新 AFP Mockup 候选，不执行收藏夹写入：

- `landscape-v9`：24 张候选中 5 张通过，人工复核 5/5 合格。海外景点与摄影师窄查询能够稳定补入 Dolomites、瑞士冰川、Grand Canyon 和 Ansel Adams / Alabama Hills 等高质量自然地貌，但初版摄影师查询也暴露出展览、人物档案和体育同名词污染。
- `landscape-v10`：收紧摄影师查询并新增展览、人物、摄影活动和 Golf 等元数据排除后，24 张候选中 6 张通过，人工高分辨率复核 6/6 合格；摄影师来源贡献 3/6 个通过项，海外景点来源贡献 1/6，全部通过项审美分均为 5。
- v10 的通过项覆盖 Antarctica 冰川、Dolomites、瑞士冰川湖、Olympic National Park 海岸日落和 Jasper National Park 雾林，说明“海外高辨识度景点 + 风景摄影师”比继续扩张泛词更能提高候选上限。
- 摄影师署名仍只作为发现信号，不能自动通过；画幅、完整环境、分层纵深、清晰锚点、负空间平衡和人物/设施干扰仍必须由像素级门槛独立确认。

2026-08-10 的宇宙恒星球体 smoke 使用 4 条窄查询、共 240 条原始召回；20 张通过本地预筛后进入视觉复核：

- 真实视觉保留 3 张，均为密集星场；合格项的宇宙覆盖率为 66%–95%，空黑比例为 8%–25%。
- 正确拒绝了小月亮/小行星、星空仅为山地或动物背景、人物日食活动、眼镜和手持商品。
- `solar eclipse` 主要召回新闻活动图，已替换为 solar flare / corona / prominence；文本预筛新增眼镜、手、包装、动物和森林等已证实污染语境。
- 首批 100 张中发现太阳/插画标题重复，因此宇宙类别进一步收紧为同标题只允许 1 张；太阳能板、蛋糕、图解、农业和迁移新闻等非天文误召回也移至本地预筛。
- 2026-08-10 的连续补量首批显示艺术宇宙视觉来源中宽泛 `planet` 词会大量召回主体不足 80% 的小行星体，因此该变体保留 `exoplanet`、星系、星云和黑洞，移除单独的 `planet`。
- 2026-08-11 的追加轮中，已收紧的空间站/卫星变体仍复核 26 张且没有通过项，主因仍是设备、展品或地景成为构图主体；默认检索现已移除此专用变体，把视觉额度交给深空形成物来源。视觉规则仍允许其他深空查询中偶然出现的次要设备。
- 2026-08-11 的追加轮在默认来源达到 10 页上限后，合格项中稳定出现 Orion、Carina、Crab、Tarantula、Vela、Cygnus 和 Magellanic 等深空对象词。已为这些命名对象加入独立窄查询，并先用 AFP 最小只读请求验证表达式可用；它们仍必须经过同一套像素级构图校验。
- 2026-08-11 的后续复核中，Horsehead、Pillars of Creation、Eta Carinae 和 Centaurus 等对象继续在已通过样本里出现，而第一组命名对象来源已耗尽。因此新增 Horsehead/Flame、Pillars/Eagle、Helix/Ring、Rosette/Lagoon、Eta Carinae 和 Centaurus A 的第二组窄查询；先用 1 条 AFP 只读请求验证表达式，再交给同一像素级壁纸门槛。第一组命名对象来源在 r09 达到 76/100 通过，第二组在 r12 达到 78/100；两次均未降低视觉阈值。
- 已配置 10 页/变体的连续分页耗尽 1,901 条原始召回，保留 67 张，尚短缺 33 张；因此新增 Hubble/JWST、超新星/类星体、黑洞吸积盘三组来源。`telescope` 不再作为本地硬排除，因为科学图说明常含该词；博物馆、模型和展览语境仍在预筛中剔除。

AFP 对过长连续 `NOT` 短语的解析不稳定；必须先逐条验证 query variant，复杂排除优先留给本地元数据预筛。更新关键词后必须重新运行候选阶段；不要把旧的 `search-candidates.json` 与新 rubric 产生的视觉结果混用。
