# 动物图片专项视觉判据（v4：账号去重 + 舒适度 + 大众喜爱 + 唯美构图）

## 账号去重与 2 万目标

开始新一轮补量前，先只读读取当前 AFP 账号所有可读取 Selection 的文档 ID。将跨收藏夹合并后的唯一 ID 作为账号排除集；客户端沙盒项如果详情接口返回 400，只记录读取错误，不把它当成空收藏夹。先从本地最终清单移除账号已收藏图片，再以 `20000 - 去重后本地数量` 计算新增目标；远端 `AutoFlow_动物` 的数量不能替代本地基准数量。

## 搜索扩展策略（v4：污染反馈闭环）

为了补充第二个 5000 张且不重复第一批，搜索入口分成五类并交叉轮换：

1. **品种与别名**：Maine Coon、Persian、Siamese、Bengal、Ragdoll、British Shorthair、Scottish Fold、Norwegian Forest Cat、golden retriever、Labrador、border collie、corgi、husky、Shiba Inu、French bulldog、Dachshund、Arabian horse、Icelandic horse、Holland lop、Netherland dwarf、Lionhead rabbit、guinea pig、chinchilla。
2. **熟悉野生动物**：snow leopard、arctic fox、sea otter、polar bear、brown bear、wolf、antelope、quokka、capybara、fennec fox、red squirrel、okapi、bongo、cockatoo、cockatiel、budgerigar、lovebird、snowy owl、hornbill、bee-eater。
3. **自然状态**：resting、sitting、standing、walking、sleeping、swimming、perched、grazing。
4. **自然环境**：meadow、pasture、grassland、forest、woodland、wetland、rainforest、snow、mountain、coast。
5. **自然光和构图**：golden hour、sunrise、sunset、soft light、morning light、natural light、wildlife photography、perched、flying、garden、park、outdoors。

6. **污染反馈回避**：上一轮真实复核中出现了足球/高尔夫/体育场人物、人物肖像、切开的猕猴桃或其他食物静物、无动物火山/风景等污染。后续搜索加入 `golfer|golf|soccer|football|athlete|stadium|sports|match|sliced kiwi|kiwi fruit|food still life` 元数据排除；不能排除裸词 `kiwi`，避免误伤 kiwi 鸟。视觉模型必须先判断主导主体，确认是人物、体育活动、食物静物或无动物风景时直接拒绝。

搜索词只负责扩大召回，不证明图片合格。品种、地点、动作、完整身体词和光线都必须重新通过像素级主体、身体完整度、清晰度、舒适度和环境门禁；搜索查询每条保持窄范围，复杂排除交给本地元数据规则和视觉校验。实测 `full body/whole body` 精确组合召回偏窄，因此查询分两层轮换：第一层使用完整身体词提高质量先验，第二层使用“品种 + side view/profile/standing profile + 动作或自然环境”扩大召回，再依靠视觉门禁确认身体完整度。新增品种查询优先使用这些组合，避免单独品种词被人物新闻语境占满。

## 必须通过

### 本轮污染反馈闭环

续搜中实际出现过人物会议、讲台、冰球、红毯、瑜伽、警察场景、博物馆雕塑/壁画、人类解剖头骨、火箭发射、楼梯建筑和摄影棚摆拍。后续先在元数据层剔除这些语境，再由视觉模型确认主导主体；任何标题或 caption 中的动物词都不能抵消像素层拒绝。

1. 真实哺乳动物或鸟类是画面主要主体，且模型必须返回 `subjectRole=primary`；不能只是背景、标牌、Logo、玩偶、吉祥物、服装、插画或屏幕内容。鱼类、爬行动物、两栖动物、昆虫、蜘蛛、蠕虫、软体动物和甲壳类不进入本轮收藏。
2. 身体尽量完整：至少 `full-body` 或 `near-full-body`。脸、眼睛、鼻子、头部、头肩、爪子、翅膀或其他局部特写直接拒绝；头部加少量躯干的紧凑特写仍是局部图；重要身体部位被裁掉也拒绝。
3. 画面清晰：毛发、羽毛、皮肤、鳞片或其他纹理必须可辨。模糊、低清、噪点重、运动拖影和主体不可辨认都拒绝。
4. 内容健康：血液、尸体、明显伤口、死亡、捕杀、惊悚或令人不适的画面都拒绝。
5. 动物状态自然：优先自然、放松、舒适的状态。被绑住、困住、明显受惊、痛苦、被强行摆拍或人为干预明显的画面拒绝。
6. 环境干净自然：不允许人物主导、笼子、明显围栏、铁丝网、脏乱环境或人工背景压过动物本身。
7. 黑猫拒绝：只要主体是黑猫，不论其他条件多好都拒绝。
8. 舒适度硬排除：任何不适动物类型、宏观昆虫、蜘蛛网、寄生虫、黏液、密集群聚、交配、捕食、追逐、叼住猎物、攻击或令人紧张的画面拒绝。
9. 大众喜爱度用于硬门槛和排序：只保留 `appealTier=high|medium`；猫、狗、兔子、马、熊猫、红熊猫、海豚、海豹、企鹅、大象、长颈鹿、狐狸、考拉、水獭、狮子、老虎、鹿和舒适鸟类优先；中优先级保留熟悉且画面友好的猴子、羊、山羊、牛、河马、犀牛、斑马、鲸鱼、猛禽、鹤、天鹅和火烈鸟。
10. 捕食和攻击拒绝：动物正在捕捉、叼住、撕咬、追逐、攻击、猎杀或明显威胁其他动物时拒绝，即使画面没有血液。
11. 构图质量拒绝：重要身体部位被叶片、其他动物、前景虚化、水面或阴影遮挡时拒绝；密集群体、拥挤兽群、海豹群落和多物种混杂场景没有单一清晰主体时拒绝；前景主体模糊或多个主体争抢焦点时拒绝。
12. 唯美构图：要求 `compositionQuality=balanced`、`aestheticScore>=4`；主体与背景层次清楚、色彩自然、光线柔和或具有明确自然光方向，拒绝杂乱、压迫、突兀裁切、背景抢主体、摄影棚/美容台摆拍和仅靠极端微距制造冲击的画面。
13. 主导主体优先：caption 中出现动物词不构成通过理由；人物、运动员、球场、食物、水果、无动物风景或活动事件占主导时，先于物种和审美评分拒绝。

## 模型输出字段

```json
{
  "animalClass": "mammal|bird|fish|reptile|amphibian|invertebrate|unknown",
  "bodyCoverage": "full-body|near-full-body|partial|head-only|close-up|unknown",
  "imageClarity": "clear|soft|blurry|noisy|unknown",
  "graphicContent": "none|blood|corpse|wound|disturbing|unknown",
  "welfareState": "natural|restrained|distressed|overly-staged|human-intervened|unknown",
  "environment": "clean-natural|human-made|cage|fence|wire|people-dominant|dirty|unknown",
  "coatColor": "not-black-cat|black-cat|not-applicable|unknown",
  "comfortLevel": "comfortable|neutral|uncomfortable|unknown",
  "appealTier": "high|medium|low|unknown",
  "interactionState": "peaceful|neutral|predation|aggression|distressed|unknown",
  "occlusionLevel": "none|minor|major|unknown",
  "groupDensity": "single|small-group|dense-group|unknown",
  "foregroundClarity": "clear|mixed|blurred|unknown",
  "compositionQuality": "balanced|busy|awkward|unknown",
  "aestheticScore": 1
}
```

`animalClass` 只能是 `mammal|bird`；`subjectRole` 必须为 `primary`；`comfortLevel` 必须为 `comfortable`；`appealTier` 只能为 `high|medium`；`compositionQuality` 必须为 `balanced`；`aestheticScore` 必须大于等于 4。`interactionState=predation|aggression|distressed|unknown`、`occlusionLevel=major|unknown`、`groupDensity=dense-group|unknown` 或 `foregroundClarity=mixed|blurred|unknown` 必须 `keep=false`。其他字段缺失、为 `unknown` 或出现不允许值时，必须 `keep=false`。
