---
kind: upgrade-guide
description: Visual Curator 不再将回贴原图的生成壁纸重新合成或作为合格成品导出。
---

# 完整生成壁纸

[English](guide.md) | 中文

## 变更

生成壁纸使用生图服务返回的完整画布。Host 不再将原图或候选像素回贴到生成背景。采用 `source-edge-v1`、`protected-context-v1`、`protected-context-v2`、`generated-canvas-protected-v2` 或 `background-plate-v1/v2` 的旧任务仍可查看，但其生成结果不能重新合成或作为合格壁纸导出。纯裁剪继续可用。`wallpaper.processing.sourcePreservation` 不再启用原图恢复。

新的直接裁剪批次采用 `practical-v2` 验收，并对最终输出作一次简短复审。汽车的全部可见部分（包括外围部件）和所有关键结构均须完整位于安全区，其他主要主体至少 97% 位于安全区；细枝等自然小末端单独评估。每个冻结的共同主角编号均须有独立 `subject/core` 区域，或明确报告该主体完全缺失；仅漏框时恢复同图复审，不重新生图。`subject/peripheral` 不能表示另一物体，也不能豁免汽车部件越界。自然背景变化仍可接受，回贴成品仍被禁止。已保存的 `practical-v1` 任务继续遵守冻结规则，只有显式采用当前策略才升级。`version: strict-v1` 保留严格受理规则。Key 通道关闭神经网络超分，订阅通道可重建较小输出。

已在 20 MiB 上传限制内正常导入的高分辨率原图，准备参考图时复用归档原件或已验证的 blob；规范化 PNG 变大后不会再次因上传限额被拒绝，原图质量保留。

## 迁移

1. 保留已有任务记录与原图文件，不清空存储或丢弃生图回执。
2. 新建直接裁剪批次，或以所有者身份调用 `wallpaper-continue`，携带 `completeCanvas: "current"` 及新的 `operationId`。续办版本保留历史与编辑次数，替换贴图尝试，并重新检查已有完整生成图。
3. 对已有成品采用 practical-v2 时，调用 `wallpaper-continue` 并携带 `practical: "current"` 及新的 `operationId`。子任务只根据原图重新识别一次主体，再复审每张最早可用的完整成品。父记录、原有角色、版本、回执和已消耗编辑次数均保留；旧验收通过不代表符合新的安全区要求。
4. 只有确实需要原生与最终两轮复审时才将 `wallpaper.processing.reviewStages` 设为 `native-and-final-v1`；其他情况使用默认 `final-only-v1`。
5. 确认最新生成尝试使用 `generated-canvas-v1`，检查实际成品有无贴图边界及重复物体，最终复审通过后再导出。远端结果未知时，须先用已保存回执查询原请求，再决定是否可以重新派发。
