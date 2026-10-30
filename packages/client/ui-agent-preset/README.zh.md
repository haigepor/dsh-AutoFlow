---
description: "在 Web 中选择 Agent preset 和新任务默认值，查看各模式的说明与声明的配置。创建与修改引导至创造模式。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-preset

[English](README.md) | 中文

## 概述

在设置页中，本分区使用共用的 26px 主标题、36px 行高、600 字重与 24px 标题间距。主标题不展示装饰图标或介绍文字，设置项的说明和操作仍保留。外壳提供左右相等的留白与 24px 顶部间距。

在 Web 中选择 Agent preset 和新任务默认值，查看各模式的说明与声明的配置。创建与修改引导至创造模式。

模式说明正文使用 13px 字号，辅助文案为 12px，示例标题为 15px。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

设置页显示内置与自定义卡片分组、默认项高亮和点击卡片选择；没有 preset 的分组不显示，但自定义分组会保留其创造入口。粗指针设备完整显示卡片描述；其他设备最多显示四行描述，悬停可查看全文。每张卡片都提供「查看配置」，以只读 YAML 打开该 preset 声明的插件列表，使用 Loader 自己的方言（含 `!!js` 条件）；加载失败的 preset 同样可读，因为其诊断信息正指向这份 YAML。Escape 只关闭查看器并将焦点还给卡片；离开设置页会清空查看器，迟到的读取结果不会重新打开它。本页不编辑任何内容：创造入口启动一个创造模式任务，以 bundle 形式创建或覆盖 preset；当 `cordis` preset 在列表中且存在会话流程时提供。

关闭通用设置中的代码工作工具后，新会话选择器和设置页列表提供标准、创造和自定义预设；开启后还提供 PTC 和极简模式。两种状态下均保留默认值选择和创造入口。选择健康定义作为默认值也会同步当前新任务页面的空白会话。Creator 入口开启一个使用 `cordis` preset 的新任务。

点击卡片立即显示「切换中…」。设置写入成功后就更新默认高亮，无需等待列表刷新。随后核对列表，再同步操作开始时捕获的空白会话；较早的读取不能覆盖已确认的写入。选择操作在这些步骤结束前保持忙碌，失败时显示错误，不把未确认的写入标记为已保存。

首次读取列表时显示四张装饰性骨架卡片，复用最终卡片的响应式网格，保留真实页面标题，通过 `aria-busy` 和状态文案提示加载。刷新时保留现有卡片与选择，读取失败显示诊断和重试操作。读取结束立即退出骨架屏，减少动画偏好下关闭明暗脉动。

已知的内置预设提供只读的模式说明与使用示例对话框，使用对应人物缩略图、不透明表面、紧凑字号和带边框的示例。打开时只渲染初始页签的 Markdown，其余页签首次访问时渲染，并保留节点与滚动位置。对话框沿用共享 Modal 入场动效，使用无背景模糊的暗色遮罩，并暂停背后的卡片插画；关闭后焦点回到打开它的操作。帮助不会改变新任务默认值。默认徽标取代卡片的分组徽标，预设 id 显示在插画区内。指南文案与示例归本包所有。

预设卡片采用纵向布局，淡色插画区位于名称、说明和操作上方。宽内容区四张并排，中等宽度改为双列，窄内容区改为单列；卡片网格在 1280px 内左对齐。透明背景的 Q 版插画统一使用蓝发鲸鱼女仆，通过代码本、工具流程、终端和插件积木区分各模式；自定义预设使用搭建图案。256px WebP 素材保留透明度，内嵌于客户端包，以 112px 显示并异步解码。悬浮或键盘聚焦卡片时插画轻微浮动，减少动画偏好下保持静止。未选中的卡片使用细边框与随主题变化的轻阴影，选中卡片保留强调色描边。卡片表面跟随当前主题。

在桌面端，模式选择器中的直接选择切换到另一个内置 preset 时，可选的[产品埋点](../product-analytics/README.zh.md)服务会收到 `agent_preset_switch`：未绑定 Session 的选择在暂存给下一个 Session 时计入，已绑定空白 Session 的选择在 Host 应用后计入。事件携带按 preset id 映射的来源与目标类别（`cordis` 记为 `creator`；`ptc`、`minimal`、`standard` 保持原 id；其他 id 记为 `other`），以及选择时已知的代码工作工具设置。选择自定义目标、被拒绝的选择、Host 最终落在其他 preset 的选择、默认值修改及其空白 Session 同步均不报告；来源模式或代码工作工具设置未知时做出的选择同样不报告。不采集自定义 preset 的 id 和名称。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`agentPresets/list` 提供列表并标记当前默认值，`agentPresets/read` 为查看器提供一条声明的 YAML；默认值的修改写入 `agent-preset-registry` settings 命名空间。选择器、空白会话同步和只读会话标签使用记录的 preset 标识。连接重置和设置更新会刷新列表。

`CreatePluginMenuItem` 使用共享的预设列表 store，向 `plugins.add.actions` 贡献菜单项。选择时先调用页面传入的 `onDismiss()`，再调用与设置页 `creatorDraft` 相同的 `startCreatorDraft` 回调。该回调通过 `AgentPresetSeatController` 暂存 `cordis`（主区空白 Session 列出其他 preset 时不暂存，因为导航会打开另一个空白 Session，原空白 Session 保持不变），再通过显式保留草稿并传入 `agentPreset: 'cordis'` 的 `uiWorkspace.startSession` 调用打开任务，由 Host 以创造模式组合被复用的空白 Session 或新 Session；没有目标工作区时，暂存选择在 Session 绑定可用时应用。暂存选择应用后即清除。代码工作工具开启或关闭时均使用同一个选择器和选择 store，`AgentPresetSeat` 通过共享的 `Toast` 组件显示拒绝原因。

`AgentPresetSeatController.select()` 与 `apply()` 返回本次尝试的结果：Host 提交暂存 preset 时为 `applied`；没有当前 Session 时为 `staged`；忙碌、没有暂存选择、Session 已开始或已使用该 preset，或 Host 最终落在其他 preset 时为 `unchanged`；Host 拒绝时为携带原始原因的 `refused`。选择器注入的 `select` 根据该结果报告 `agent_preset_switch`，并且只返回拒绝原因。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Scope](../../core/scope/README.zh.md) — 注册隔离。
- [Agent](../../core/agent/README.zh.md) — 会话运行时。
- [Cordis](../../../docs/cordis-primer.zh.md) — 插件配置与生命周期。

<a id="model-experience"></a>
## 模型体验

通过选定的 preset 间接影响模型，其插件拥有模型可见能力。

#### KV Cache effect

选择变更只影响之后的任务，已有插件与提示词保持不变。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- Web 不创建也不编辑 preset：配置查看器是只读的；通过创造模式安装的 bundle 声明新 preset，或按行 id 覆盖内置 preset，覆盖会替换整个子插件列表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
