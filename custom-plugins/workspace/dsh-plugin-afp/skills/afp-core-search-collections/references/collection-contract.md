# 收藏夹工作流契约

## 端点

| 操作 | AFP 接口 | 使用方式 |
|---|---|---|
| 查询选集 | `GET /get-selections/byuser?includeClientSelections=true` | 每次 collections 阶段先读取 |
| 创建选集 | `POST /create-selection` | 仅 `afp_apply` 且固定名称不存在 |
| 读取详情 | `GET /get-selections/byid/{SELECTION_ID}` | 用于按文档 ID 去重 |
| 加入图片 | `PUT /add-selection-docs/{SELECTION_ID}` | 每次只加入一张图片 |
| 清空目标 | `PUT /delete-selection-docs/{SELECTION_ID}` | 仅精确 AutoFlow 目标，`{ "docIds": [], "deleteAll": true }` |

## 认证预检

每个 AFP 工具调用 先运行 Host 凭据服务：

1. 若 access token 是 JWT，检查其 `exp` 是否超过 `AFP_TOKEN_REFRESH_MARGIN_SECONDS` 的剩余窗口。
2. 对未过期 JWT 或非 JWT token，调用只读 `GET /get-selections/byuser?includeClientSelections=true` 验证。
3. 缺失、即将过期、HTTP 401 或 HTTP 403 时，调用 Hub `getlogin` 获取新 access token 并缓存到 DSH 凭据服务。
4. refresh token 不写入 DSH 凭据服务、运行时清单、报告或控制台；当前使用账号密码重签发 access token。

## 写入规则

1. 仅复用唯一、精确名称且 `type=PRIVATE` 的 Selection。
2. 同名私有 Selection 多于一个时，报告 `ambiguous`，本类不写入。
3. 创建成功后读取详情，再对 `id` 不存在的文档逐张加入。
4. 单张失败只记入 `failedCount`，不停止后续图片；默认每张额外重试一次。
5. 清空只允许对五个精确 `AutoFlow_*` 私有目标使用 `delete-selection-docs`；禁止删除 Selection 本身，禁止对其他名称使用 `deleteAll:true`。

## 搜索 checkpoint 与去重契约

1. 视觉复核前必须排除远端 Selection 已存在的文档 ID、历史候选/视觉决策/元数据拒绝/重复排除清单中的文档 ID、当前进程重复 ID 和历史候选的规范化标题簇。任一层命中都不能再次提交给视觉 Provider。
2. 同一进程内还要排除不同 query variant 重复召回的图片 ID；最终 `collections` dry-run 重新读取远端 Selection，再做一次 ID 去重，不能信任旧报告中的“未收藏”结论。
3. FAR 分页必须读取 `hasMore` 和 `cursor(direction: next)`。每个 query variant 独立保存 `queryHash`、`cursor`、`pagesFetched`、`exhausted`、`stoppedBecause`、`seenCursors`、`fallbackSucceeded`，需要时保存 `fallbackSkipped`/`fallbackError`；类别同时保存已召回但尚未送审的 `pending`/`deferred` 队列，写入 profile 的 AFP 运行记录（或显式 `runId` 路径）。
4. `max-pages` 是本次进程的分页预算，不是永久耗尽标记；`stoppedBecause=max-pages-reached` 且存在下一页 cursor 时，预算不能在同一次启动的下一批重置；续跑从该 cursor 恢复。只有 `no-more-results`、`missing-next-cursor`、`repeated-cursor` 等真实终止状态才可永久标记 exhausted。
5. 每批报告必须可区分 `rawRecallCount`、`metadataRejectedCount`、`duplicateExclusionCount`、`visualKeptCount`、`visualRejectedCount`、`pagesFetched` 和 source-level metrics；历史 ID、标题簇和重复 query variant 必须进入重复审计，不能伪装成 metadata reject。字段回退的来源统计使用实际成功变体的 `fieldMode`/`query`/`queryHash`，跨进程恢复时必须优先消费 `pending`/`deferred`，再请求保存 cursor 的下一页。

加入图片的结构固定为：

```json
{
  "id": "DOC_ID",
  "guid": "DOC_GUID",
  "title": "DOCUMENT_TITLE",
  "docClass": "picture",
  "provider": "PROVIDER_CODE"
}
```

运行时报告只记录计数和动作，不记录真实文档 ID、Selection ID、认证信息或临时媒体地址。
