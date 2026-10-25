---
kind: upgrade-guide
description: Visual Curator 在原有人工发布导出之外新增第二版模型参考档案格式。
---

# Visual Curator 模型参考档案

[English](guide.md) | 中文

## 变更

可选 Visual Curator 插件将有图片依据的规则自动保存为不可变的 `modelProfile` 记录。仅引用的参考导出使用 `profileExport` 记录和 `formatVersion: 2` JSON 封装，包含模型生成的风格偏好，无需人工发布或监督数据划分。现有人工发布版本、标签和第一版导出的字段与行为保持原义。

`visual_style_get` 返回 `modelProfile`。其有效 `id` 可作为找图、裁图和参考导出操作的 `releaseId`。模型档案导出接受 `kind: style` 或 `skill`、`purpose: reference`、`mode: references-only`，省略 `splitId`；其他导出用途继续使用原有人工发布流程。

## 迁移

1. 自定义数据集读取器按 `formatVersion` 选择解析方式，从 `style-profile.json` 读取第二版的 `activeRules`、`ruleSelections`、分组和模型来源；保留第一版解析，并在使用前校验每个文件的校验和。
2. 使用模型档案的调用方读取当前准确的 `modelProfile.id` 与过期状态，不构造发布 ID，也不要求逐条审核；启动任务后固定所选 ID。
3. 降级插件前备份当前配置空间的 Visual Curator 存储。旧构建不识别新增记录类型，降级时需恢复匹配的备份；原图片无需迁移，也不会复制。
4. 确认完整分析后显示自动选入的规则，生成数据集下载第二版仅引用数据包；人工监督导出仍须检查其已有划分与人工标签。
