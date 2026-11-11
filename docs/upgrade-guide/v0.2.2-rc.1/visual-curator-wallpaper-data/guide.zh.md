---
kind: upgrade-guide
description: 保存新派生图或任务证据后，Visual Curator 壁纸及 Codex 图片数据需要更新后的读取器。
---

# Visual Curator 壁纸数据

[English](guide.md) | 中文

## 变更

壁纸记录增加 `composition` 判别字段、处理元数据和带版本的 Run 检查点。更新后的读取器保留已有图片、分析、导出、数据集及三节点布局。旧读取器无法解释新增变体，写入后应保留更新后的插件。不迁移 Session 格式或模型权重。

可恢复蒙版扩图需要配套的原生 LLM（大语言模型）任务接口及 Codex Subscription 适配器。只将 Visual Curator 安装到旧桌面不会增加这些能力。纯裁剪仍可执行，需要扩图时会停止并提示能力缺失。

读取器保留冻结的 V1–V5 规划、`wallpaper-plan-detail-v1/v2`、`wallpaper-outpaint-v3` 及生成回执。`protected-context-v2` 重新合成复用已有生成结果，不能声称使用了不同蒙版；显式手动修正仍保留累计编辑限制。`wallpaper-plan-v5` 局部检查点保存 `detailAnalysis`，恢复时创建子任务。当前 `wallpaper-plan-v6` / `wallpaper-outpaint-v4` 增加场景专属编辑提示词和有序参考图证据。

参考图分析支持 `visual-curator-reference-v4`（保留 V3 读取）及 `visual-curator-summary-v5`。`wallpaper-review-v4` 要求原有检查及清晰度全部通过，可保存清晰度证据和独立复审的超分派生版本。旧复审不算作已完成当前检查。

直接原图批次使用 `wallpaper-direct-v1`、第 `2` 版检查点、`wallpaper-review-source-v1` 和冻结的 `source-faithful-v1`，不关联风格发布、训练参考或找图父任务。第 1 版任务及冻结风格复审仍可读取，不重写已有任务、原图或成品。

可选的壁纸 `backgroundResolution` 保存独立的 CPU 背景超分证据。增强背景属于派生产物，不是服务原生高清原件；保护校验及独立复审仍必须执行。历史记录没有该字段时保持原样。

Codex 任务增加可选的 `evidence` 和逐产物 `generationId`。实际指定的请求设置、服务报告及附件像素尺寸分别保留：请求高质量不能将服务报告的 941×1672/low 结果变成原生高清。不重建历史响应。旧版严格读取器可能拒绝新增字段，不得通过删除证据让其加载。

当前配置增加 `limits.idlePollIntervalMs`，空闲工作台发现任务的间隔为 30 秒。冻结的旧配置及进行中的导入、参考分析轮询保持不变；旧配置读取器可能拒绝该字段。

`wallpaper.decision` 及逐图 `decisions` 冻结处理次数限制。新任务启用决策，旧任务须主动接入。

## 迁移

1. 测试前停止 Profile 并备份其数据目录，与活跃写入目录分开保存。
2. 使用配套源码桌面、Visual Curator 及 Codex Subscription 包处理蒙版壁纸。[本地流程](../../../../custom-plugins/workspace/dsh-plugin-visual-curator/README.zh.md#wallpaper-workflow)定义入口及指令。
3. 打开已保存找图批次并启动壁纸处理，确认后续规划、产物、复审回执及清晰度阶段。历史阶段没有清晰度证据时保持未执行，数据集及预览找图仍可使用。增强背景还须确认独立 CPU 处理证据及独立复审。
4. 对旧任务中停留的图片点击“处理决策”，确认动作及保留的次数限制。
5. 检查新 Codex 回执：区分请求、服务报告设置及附件尺寸，不补造历史回执字段。
6. 写入新记录后，如需降级，应停止 Profile，同时恢复测试前数据备份及旧包。不要删除字段或改写个别 manifest（元数据清单）。
