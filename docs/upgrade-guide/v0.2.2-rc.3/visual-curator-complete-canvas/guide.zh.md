---
kind: upgrade-guide
description: Visual Curator 对完整生成图执行原图保真复审，禁止批准、重新合成或导出任何原图及候选回贴模式的结果。
---

# 原图取景与生成壁纸

[English](guide.md) | 中文

## 变更

新的 practical 直接原图批次采用 `source-intent-v2`，冻结原图媒介、取景、可见实体及保留要求。局部取景或特写的非汽车主角须填写 `layoutFocus`，完整可见实体框仍是保真依据。最小尺寸保留比例默认 0.9，V2 比较包围框长边。证据不确定时保持待复核；局部取景与正常遮挡不授权补画未见身体。重构仍要求完整主角或关键实体确有损伤，并具有冻结的 `repair-when-needed` 授权。

新的 `wallpaper-edit-input-v6` 固定已定位画布、原图、安全参考及透明通道蒙版。V2 在原有取景可行范围内使主角居中，只开放待扩背景。已保存请求不变。读取 V6 或 `source-framing-review-v1` 记录前须更新插件。

新 `subject-fill-v1` 任务保存动作道具 ID，并核对主体之间的相对构图。读取这些任务需要更新插件。

`source-framing-review-v1` 在生图前保存原图观察、不兼容条件、标注及有上限的真实局部证据。原图专用 `reinspect` 可校正几何，但不改变身份、角色或保留要求。证据不确定或构图仍冲突时保持未合格，不补画肢体、不放宽安全区。历史上未保存位置的规划失败须显式创建恢复子任务，保留父任务、已通过图片与累计预算。

生成壁纸采用 `generated-canvas-v1`，使用生图服务返回的完整画布，不回贴原图或候选像素。`source-intent-background-v1`、`source-edge-v1`、`protected-context-v1/v2`、`generated-canvas-protected-v2` 与 `background-plate-v1/v2` 保留为可查看的历史，但不能重新合成、批准或作为生成壁纸导出；`wallpaper.processing.sourcePreservation` 也不能启用。独立复审以实际原图和成品像素核对取景、外观、关系、媒介、接缝与透视。

`practical-v2` 要求汽车和关键结构完整位于安全区，其他主要主体至少 97% 位于安全区，细小末端单独评估。每个共同主角均须有独立核心框或明确缺失报告，漏框时恢复同图复审，不重新生图。纯裁剪继续可用。历史策略保持冻结，已记录的通过不能批准回贴图。严格受理规则不变；已接受的高分辨率原图复用已验证归档。Key 通道关闭神经网络重建，订阅通道可重建较小输出。

取景保真任务返工只返回 `imageVersionId`、`editPrompt` 和 `reason`，Host 保留冻结原图事实；明确继续任务时采用该协议。历史局部取景规划缺少焦点时在生图前停止，请从原图新建批次重新观察。

## 迁移

1. 保留任务记录、原图文件和生图回执。采用原图取景观察与复审时新建 practical 直接原图批次；已有任务不迁移或重新标为通过。如需调整默认 0.9 的比例，在创建前配置 `wallpaper.sourceIntentPolicy.minimumSubjectScaleRatio`。
2. 已有所有者授权的 `wallpaper-continue` 操作携带 `completeCanvas: "current"` 或 `practical: "current"` 及新 `operationId` 时，继续保留原有操作范围、父任务历史和已消耗编辑次数，不增加 source-intent 策略。
3. 保持默认 `wallpaper.processing.reviewStages: final-only-v1`；确实需要两阶段时选择 `native-and-final-v1`。
4. 导出前确认新任务的冻结策略、`generated-canvas-v1` 合成模式及独立最终复审，检查实际完整生成图，不复用原图回贴产物。远端结果未知时先用已保存回执查询原请求，再决定是否重新派发。
