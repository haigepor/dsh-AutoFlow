---
kind: upgrade-guide
description: AFP 视觉请求改用统一配置的原生模型，不再使用插件独立的接口与密钥。
---

# AFP 视觉模型选择

[English](guide.md) | 中文

## 变更

AFP 从“设置 → 模型”选择支持图片输入的供应商和模型，由原生 LLM 适配器管理接口、协议、认证和请求默认参数。AFP 不再通过 `visionBaseUrl`、`visionKeyRef` 发送请求，也不添加独立的推理覆盖。已有报告仍可读取；继续报告使用当前选择的模型，新请求记录保存实际路由、参数、提示词和归一化附件引用。

## 迁移

1. 在“设置 → 模型”配置原视觉服务。OpenAI 兼容服务保持原接口、模型 ID 和凭据引用，并启用图片输入；可直接复用已有 `VISION_API_KEY` 引用，无需复制密钥值。
2. 在“AFP → 视觉模型”选择该模型并保存。部署覆盖使用 `visionProvider` 和 `visionModel` 选择同一路由，参见[示例](../../../../custom-plugins/workspace/dsh-plugin-afp/config.example.patch.yml)。
3. 旧字段仍允许读取。未配置 `visionProvider` 时，仅在完整模型目录中唯一匹配旧有效模型 ID 的图片模型才能自动接入；同名歧义、目录不完整或模型缺失均要求明确选择。不会回退到旧接口或凭据。
4. 确认 AFP 能选择该供应商和模型，并完成少量图片筛选。以后统一在“设置 → 模型”修改接口与凭据；预览下载和收藏夹认证继续使用 AFP 账户。
