---
kind: upgrade-guide
description: "Codex 订阅模型需要在 profile 中明确选择，才会出现在应用和中转目录中。"
---
# 明确选择 Codex 订阅模型

[English](guide.md) | 中文

## 变更

Codex 订阅插件只通过 AutoFlow 和 `GET /v1/models` 发布 `options.catalog` 中选择的文字模型。账号登录与 `model-list` 仍发现上游候选，但不会将其添加到这些目录。已有账号、凭据、当前模型目标和已准备请求保持不变。生图模型使用图片工具与 MCP，新增生图模型不修改默认生图目标。

## 迁移

1. 打开设置 → 模型 → ChatGPT 订阅 → 新增模型，选择要发布的文字模型，或管理生图模型 ID。只有需要修改默认生图目标时，才开启对应开关。
2. 方法调用方先读取 `model-catalog`，再调用 `model-catalog-save`，提交其 `revision` 与包含 `kind`、`id`、`name` 的完整 `entries`。直接编辑 profile 时，可在 `cordis.patch.yml` 的 `codex-subscription` 条目设置 `options.catalog`，保留其他选项。
3. 在模型目录与提供商页签，或已认证中转的 `GET /v1/models` 中检查已选文字模型。选择为空时，文字目录为空；已保存账号仍可在 ChatGPT 订阅中查看。
