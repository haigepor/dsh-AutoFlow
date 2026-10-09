# AFP 图片候选去重与分页契约

本契约适用于所有会把 AFP 图片候选交给视觉复核或收藏夹计划的 Skill。它把“找到合格图片”与“确认图片尚未被收藏”定义为两个必须同时满足的条件。

## 视觉前去重顺序

刷新编排器的单轮候选预算固定为 1–100；超过 100 必须在调用 AFP/预览前拒绝，不能通过扩大 `batchSize` 绕过视觉审核上限。

在调用 Mockup 或 Vision Provider 之前，必须按以下顺序建立排除集：

1. 重新读取 AFP Selection 详情，收集所有非目标收藏夹的图片 ID。
2. 当目标收藏夹允许补量时，同时收集目标收藏夹中已经存在的图片 ID。
3. 读取历史候选、历史视觉决策、历史元数据拒绝和历史重复排除记录，合并其中的图片 ID。
4. 排除当前进程中跨 query variant 重复出现的图片 ID。
5. 排除规范化标题相同或属于同一图集的候选。
6. 只有通过上述排除的候选才允许请求预览和视觉模型。

所有排除都记录为 `duplicateExclusionCount`，并保留 `duplicateExclusionReasons`。重复候选写入 `duplicateExcludedCandidates`，不能放入 `rejectedMetadataCandidates`，也不能计入 `metadataRejectedCount` 或 `visualRejectedCount`。

## 连续分页

每个 query variant 独立维护 `cursor`，只能使用 AFP 返回的 `hasMore` 与 `cursor(direction: next)` 继续请求。固定的 `maxRows` 只是单页大小，不代表下一批是新结果。字段优先查询无结果或失败时可以设置回退跳过标记并转到下一字段，但不得把 `fallback-empty` / `fallback-query-failed` 当作终止原因；来源审计的 `fieldMode`、`query`、`queryHash` 必须指向实际成功使用的变体。

每次保存 checkpoint 时必须保留：

- `queryHash`、`criteria`、`fieldMode`；
- `cursor`、`pagesFetched`、`seenCursors`；
- `exhausted`、`stoppedBecause`、`fallbackSucceeded`，以及需要时的 `fallbackSkipped` / `fallbackError`；
- 已经召回但尚未送审的 `pending` 与 `deferred` 候选队列。

`max-pages-reached` 表示本轮暂停，variant 的 `exhausted` 必须保持为 `false`；下一轮必须从保存的 cursor 或未消费队列恢复；`no-more-results`、`missing-next-cursor` 和 `repeated-cursor` 才表示该 variant 终止。禁止每批无状态地重新请求第一页。

## 最终写入前复核

`collections` dry-run 前必须读取收藏夹详情并按图片 ID 做最后一次去重；`afp_apply` 还必须在初次计划生成后再次读取全量收藏夹、重建排除集和计划，再进入目标详情读取与写入。dry-run 可以报告目标缺失或计划短缺；只有显式 `afp_apply` 才允许远端写入。

## 必须可审计的统计

候选报告至少区分：

- `rawRecallCount`：AFP 原始召回数；
- `pagesFetched`：真实请求的页数；
- `metadataRejectedCount`：文本预筛拒绝数；
- `duplicateExclusionCount`：已收藏、历史、跨来源和标题簇排除数；
- `visualKeptCount` / `visualRejectedCount`：视觉结果数。
