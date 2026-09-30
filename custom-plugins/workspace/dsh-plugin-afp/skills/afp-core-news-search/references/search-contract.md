# AFP 搜索契约

## 已证实的检索模型

- `nature` 取值为 `all`、`articles`、`photos`、`videos`、`graphics`、`packages`、`events`。
- Hub 的 `getNature` / `getNaturesEvents` 用于聚合数量；FAR 查询返回当前标签卡片；FCT 只返回筛选项，不返回卡片。
- 分页保留原始查询与筛选，只追加 `cursor`。
- FCT 项的 `value` 是稳定请求值；`label` 只用于界面展示。

## 查询语义

- 双引号表示精确短语；`AND`、`OR`、`NOT` 必须大写；括号决定组合顺序。
- 未显式组合的多词按 `AND` 规划。
- 字段限定可使用 `title`、`caption`、`keyword`、`person`、`location`、`country`、`provider`、`slug`。
- 显式布尔表达式、括号和字段限定必须原样保留；只在宽松回退中移除普通精确短语的引号，不能改变字段值或布尔结构。

## 解释边界

- AFP 搜索默认覆盖多种索引字段；卡片展示字段不等于服务端真实命中字段。
- 本地评分只解释可见 title、caption、slug、关键词与实体关键词，不替代服务端召回或排序。
- `caption` 命中可提升“主体相关性”置信度，但没有视觉标签时必须标记 `visualEvidence: unavailable`。
- 主体搜索输出 `high-confidence`、`extended-match`、`manual-review` 三组，并保留原始召回入口。

## 使用顺序

1. 生成最小 criteria，确定 language、nature、dateRange。
2. 通过 Hub 获取规模；规模过大时读取 FCT。
3. 从 FCT 选择稳定 `value` 组成 filters。
4. 调用 FAR 获取卡片并记录 `hasMore`、`cursor`。
5. 只对可见字段做解释性评分，不隐藏低置信结果。

## 证据来源

- [`docs/api/09-search-analysis.md`](../../../../docs/api/09-search-analysis.md)
- [`docs/api/13-official-search-model.md`](../../../../docs/api/13-official-search-model.md)
- [`docs/api/15-search-precision-experiments.md`](../../../../docs/api/15-search-precision-experiments.md)
