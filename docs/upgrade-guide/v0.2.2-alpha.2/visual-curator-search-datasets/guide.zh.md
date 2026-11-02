---
kind: upgrade-guide
description: "Visual Curator 自动准备找图数据集和固定反例参考需要同步更新 Host 与客户端。"
---

# Visual Curator 找图数据集

[English](guide.md) | 中文

## 变更

新找图任务可使用 `autoPrepareDataset`，无需显式指定 `datasetId`。缺少完整风格包时，先创建原生会话，再准备数据包。已受理的人工启动任务可将完整包保存到素材库供后续复用。仅反例观察包用于补充当前完整包，不能替代风格规则，也不能让旧版完整包匹配当前画像。

新任务默认附带当前反例观察。去重后的观察、判断及符合条件的反例包来源在任务受理时固定，并放入会话附件。此前已受理的任务沿用原始输入。保存的启动记录和响应可包含 `negativeReferences` 与 `preparing-dataset` 阶段，旧版插件读取器不支持这些字段。

## 迁移

1. 等待当前任务结束，同步更新 Visual Curator Host 和客户端，重启 DSH 后刷新页面。无需编辑数据目录或重新分析。
2. 自定义启动客户端省略 `datasetId` 时，可传入 `autoPrepareDataset: true`；先检查 `automaticDatasetPreparation` 和 `negativeReferenceDatasets` 能力，重试沿用已受理操作的 ID。显式选择的数据包仍须匹配当前画像。
3. 在缺少当前完整包时发起新找图，确认准备数据包期间即可进入会话，随后继续搜索；重新打开数据集列表可见可复用完整包。弹窗单独显示去重后的反例数量。
4. 重新打开新保存的启动任务时保留新版读取器。此前已受理的任务不会追溯添加反例观察。
