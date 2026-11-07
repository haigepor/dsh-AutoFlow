---
kind: upgrade-guide
description: 保存新合成派生图后，Visual Curator 壁纸数据需要更新后的插件读取器。
---

# Visual Curator 壁纸数据

[English](guide.md) | 中文

## 变更

壁纸工作流增加 `composition` 图片版本判别字段、壁纸处理元数据和带版本的任务检查点。更新后的插件继续读取已有图片、分析、导出及三节点布局。旧插件不识别新派生图；写入壁纸数据后不支持直接降级。不迁移 Session 格式或模型权重。

可恢复蒙版扩图还需要配套的原生 LLM 任务接口及 Codex Subscription 适配器。只将 Visual Curator 导入旧桌面不会增加这些能力。纯裁剪仍可执行，需要扩图的图片会停止并提示能力缺失。

新任务还保存提示词标识 `wallpaper-plan-v2`、`wallpaper-outpaint-v3` 及合成模式 `protected-context-v2`。更新后的读取器保留旧任务提示词与生成回执；旧读取器不支持这些新标识。重新合成复用已有生成结果，不能声称该结果使用了不同的生成蒙版；显式手动修正仍保留累计编辑限制。

## 迁移

1. 本地测试前先停止 Profile，备份其数据目录，并与活跃写入目录分开保存。
2. 使用配套源码桌面及更新后的 Visual Curator、Codex Subscription 包处理蒙版壁纸。[本地流程](../../../../custom-plugins/workspace/dsh-plugin-visual-curator/README.zh.md#wallpaper-workflow)定义入口及指令。
3. 打开已保存找图批次并启动壁纸处理，确认后续节点显示真实规划、产物及复审回执。已有数据集及预览找图仍可使用。
4. 写入壁纸数据后，如需返回旧插件，应停止 Profile，同时恢复测试前数据备份及旧包。不要删除或改写个别 manifest 来绕过旧读取器限制。
