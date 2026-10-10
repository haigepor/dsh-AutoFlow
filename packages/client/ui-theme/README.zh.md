---
description: "dsh Web 客户端的外观主题设置：配色模式、强调色、界面字体、圆角、正文字号与插件前引导。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-theme

[English](README.md) | 中文

## 概述

`dsh-client-ui-theme` 拥有设置中的「外观主题」分区：跟随系统／浅色／深色模式、官方默认与当前项目两套配色、五种界面字体、五档圆角、菜单动效速度，以及 10 至 22 px 的会话正文字号。回环客户端把这些选择存入 `ui-theme` 设置命名空间，本地提供方默认将其持久化到 `$DSH_HOME/cordis.patch.yml`。插件通过 `prefers-color-scheme` 解析 `system` 并发布不可变的 `ThemeSnapshot`；ui-layout 把每份快照应用到文档。本包还提供 `--dsw-*` token 样式表，并在外壳加载前同步注入所选值。第三方主题可通过 `ctx.theme` 注册别名 token 覆盖。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

用户在设置侧边栏的「外观主题」独立分区选择外观。功能插件通过 `ctx.theme` 消费当前快照，并在 CSS 中读取 `--dsw-*` token；它们不自行管理主题状态。

本页占满设置外壳提供的内容宽度，并把五个偏好分组标题贡献给跨页面搜索索引。选中搜索结果会聚焦对应标题，不会挂载其他设置页。

### 外观选项

外观页采用与通用设置一致的单列设置行：左侧为名称与说明，右侧为 36px 选择控件，上下内边距 16px，行间使用细分隔线。三张等宽模式卡直接切换跟随系统、浅色和深色，选中时显示细边框与按下状态。两张紧凑配色卡展示本包绘制的 SVG 界面预览与「蓝灰」「鸢尾紫」名称，分别选择官方默认与当前项目配色。预览颜色独立于当前激活的配色，并随浅深模式切换。三个共享菜单分别选择界面字体、圆角与菜单高亮移动时长（80、140、220、300 或 400 ms）。字体控件和菜单中的每个名称都用对应的本地字体显示；系统默认预览独立使用设备字体栈，不继承当前界面字体。控件右边缘对齐，窄屏时移到说明下方。菜单使用 token 化表面、选中勾选、portal 定位与键盘导航。五种现有字体为系统默认、Source Sans 3、IBM Plex Serif、JetBrains Mono 与 IBM Plex Sans Condensed。官方默认配色取自 `dsh-v0.2.0-rc.1` 发布标签；其会话与全窗口设置页内容区使用官方主背景色，并与官方侧栏背景色配对。当前项目配色保留暖灰与鸢尾紫。代码和品牌文字保留独立字体栈。服务接受的写入经 Host settings API 按操作顺序携带命名空间 revision 串行处理，最新写入被拒时重新加载持久值。非 loopback 页面把选择保留在进程内。

Web 与 Desktop 默认使用蓝灰（`themeSet: official`），未明确选择配色的旧用户设置也使用这一默认值。已保存的配色选择保持不变；旧强调色只用于明确选择当前项目配色的设置。新安装与「重置外观」会恢复官方默认、跟随系统、系统字体、标准圆角和 220 ms 动效。已保存的 Inter 与思源黑体仍可读取，并在用户主动选择新字体前保留显示。

### 注册主题

组合可以通过 `ctx.theme` 注册带别名 token 覆盖的第三方主题 id；覆盖层按注册顺序折入活动快照的 token 中。移除其中一个绝不会覆盖最后一个持久化的内置偏好。第三方主题 id 仍是进程内扩展，不会跨越内置 settings schema。

### 插件前调色板

当主机组合包含 HTTP 服务器时，宿主侧会把已注册的 `ui-theme` 设置或 schema 默认值嵌入每份 index 响应。head CSS 会在任何脚本运行前选择文档画布的配色方案，其中 `system` 偏好使用 `prefers-color-scheme` 查询；随后，body 脚本会在加载页面和应用脚本之前设置 `body[data-ds-dark-theme]`、强调色／字体／圆角属性与 `--dsh-content-font-size`，因此首帧绘制就采用所选值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

公共菜单通过 `MenuSurface` 共享 `--dsw-menu-surface-fill`、模糊和菜单专用投影；独立菜单使用 `--dsw-menu-standalone-fill` 和相同投影。平台代码让独立菜单在 macOS 上保持近不透明，并在减少透明度或不支持模糊时让两种菜单填充改为实色。其他浮层保留 `--dsw-specific-menu`。源码约束见[样式参考](../../../docs/web-styling.zh.md#component-rules)。模态遮罩保留深色半透明填充，并使用主题定义的轻微背景模糊。

会话表面使用 `--dsw-specific-conversation-fill`：亮色为白色，搭配暖灰侧栏（`#F1F0ED`）；暗色为 `#20201E`，搭配 `#161615` 侧栏。此 token 保持不透明，确保文字和输入区易读。

系统提示的颜色按主题配对：`--dsw-alias-toast-bg` 和 `--dsw-alias-toast-label` 控制底色与文案，`--dsw-alias-toast-warn`、`--dsw-alias-toast-success` 和 `--dsw-alias-toast-action` 控制图标与行内操作。官方配色在亮色模式使用白底深色文字，在暗黑模式使用炭灰底浅色文字；两种模式分别定义操作、成功和警告颜色。

<details>
<summary>实现细节——点击展开</summary>

服务拥有外观状态并发布快照。ui-layout 展示转换器应用这些快照，token 样式表则拥有颜色、字体、圆角与会话文本尺度。

### 样式表

`base.css` 持有共享圆角尺度与设置卡片材质别名。材质别名在 `body` 上随当前色板解析。组件圆角选择遵循 [Web 样式参考](../../../docs/web-styling.zh.md#corner-radii-and-settings-cards)。

`src/styles/` 下有八张样式表，由 ui-theme 的动态客户端 entry 依次导入：`base.css`、`corner-shape.css`、`design-platform.css`、`focus.css`、`onboarding.css`、`scrollbar.css`、`gradient-shadow-text.css` 与 `shiki.css`。客户端 bundle 将其编译并注入为插件持有的全局样式，因此卸载与 HMR（热模块替换）会随 ui-theme 一同移除。`scrollbar.css` 消费 `--dsw-alias-scrollbar-*` token，必须排在声明这些 token 的 `design-platform.css` 之后。状态标记使用各自的语义状态 token。`--dsw-alias-bg-document-selection` 以本地紫色链接色绘制文档原色上的选区，浅色主题不透明度为 36%，深色主题为 34%。`design-platform.css` 还负责代码差异底色的别名及其静态透明度色阶，以及文件对比所用的 `--dsw-alias-file-diff-*` 代码区、行号区和标记配色；`shiki.css` 负责语法颜色。

[`focus.css`](src/styles/focus.css) 提供 `:focus-visible` 兜底：通过 `var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))` 声明焦点环颜色，并通过 `--dsw-focus-ring-width` 声明标准宽度，但不声明轮廓样式——因此禁用轮廓的控件仍然不绘制，而没有自有焦点环的控件保持标准几何，而不是落到 Chromium 的 `auto 1px`。主题将该蓝色解析为浅色模式的 `#4176E6` 和深色模式的 `#7AAAFF`。组件轮廓与焦点环阴影使用同一颜色表达式，包括后代和伪元素上的环。`--dsw-focus-ring-width`（2px）是标准宽度；密集表格与工具栏可以保留 1px，offset 仍由组件决定。

指针模态下，`html[data-input-modality='pointer'] body :focus-visible:not(:read-write)` 将焦点环颜色设为透明。后代与伪元素继承该值；规则不清除 `box-shadow`，因此 elevation 阴影与选中态边框独立于焦点环可见性。匹配 `:read-write` 的可编辑文本控件在点击时保留自身焦点反馈。[输入模态](../ui-primitives/README.zh.md#input-modality)决定何时恢复键盘焦点样式；它不移动 DOM 焦点。

菜单图标使用 `--dsw-alias-menu-icon`：浅色模式为 neutral-bluish 800，深色模式为 `label-primary-dimmed`。

`base.css` 仅抑制[基础控件焦点工具](../ui-primitives/README.zh.md)通过 `data-dsh-automatic-focus` 标记的聚焦元素外轮廓线；正常键盘焦点样式、边框、阴影及错误状态保持不变。

系统提示使用 `--dsw-alias-toast-bg` 和 `--dsw-alias-toast-label`，在各调用方之间统一背景与文字颜色。文档预览配对使用 `--dsw-alias-bg-document-preview` 与 `--dsw-alias-label-document-preview`，使底色与状态文字遵循相同主题。Tooltip 键帽使用 `--dsw-alias-tooltip-key-bg`，由各主题的 tooltip 背景派生稍浅的填充。开关使用 `--dsw-alias-switch-thumb`、`--dsw-alias-switch-active-track`、`--dsw-alias-switch-active-thumb`、`--dsw-alias-switch-loading-track`、`--dsw-alias-switch-loading-thumb` 与 `--dsw-alias-switch-loading-indicator`：暗色关闭态滑块为暖灰色，开启轨道跟随强调色并降低暗色亮度，写入期间使用中性轨道，以及与各主题对比度匹配的滑块和圆环。

`--dsw-alias-label-shimmer` 为共享文字扫光提供叠加色：浅色配色使用 30% alpha 的黑色，深色配色使用 45% alpha 的白色。`--dsw-alias-label-deep-diving` 和 `--dsw-alias-label-deep-diving-shimmer` 提供本地紫色活动文本和扫光颜色；深色主题使用更亮、饱和度更低的文字，并以更亮的紫色扫光。

模型菜单吸顶标题使用 `--dsw-alias-menu-group-header-fill`，按亮暗配色由现有菜单和层级 token 派生。

`brand-font.css` 导出本地 Montserrat Light、Regular 和 Medium 字体（正体、字重 300、400 和 500），`lib/styles/` 同时提供 `montserrat-light.woff2`、`montserrat-regular.woff2`、`montserrat-medium.woff2` 及其 SIL Open Font License。Desktop 将同一份样式表、字体和许可证打包，用于欢迎页品牌文字的离线显示；界面字体选项不改变品牌文字。

`appearance-font.css` 按选择加载本地字体，并为中文回退到系统字体。Source Sans 3、IBM Plex Serif、JetBrains Mono 和 IBM Plex Sans Condensed 固定下载自 Google Fonts 提交 `23e54b51ddffbc7713c583748e3bd86f62b1fa4a`，其 OFL 许可证与资源一同打入 `lib/styles/`。Inter 与思源黑体仅用于读取旧的保存设置。系统默认选项无需下载 Web 字体。

`corner-shape.css` 平滑所有圆角：在 `@supports (corner-shape: superellipse(1.5))` 内定义 `--dsw-corner-shape`，并通过通配选择器应用到所有元素及其 `::before`/`::after`，因此不支持 `corner-shape` 的引擎保持普通圆弧。正圆形状——`border-radius: 50%` 的圆与胶囊半径——因超级椭圆会使其变形，须在所属组件样式表中把 `corner-shape: round` 与半径声明配对；corner-shape 样式表 spec 跨全部包样式表强制这一配对。

`gradient-shadow-text.css` 从 `--dsh-content-font-size` 派生 `--dsh-content-font-delta`，并以该增量移动 Markdown 标题与基础文本阶梯。它同时派生低一档变量 `--dsh-content-font-size-secondary`（设置 ≤14 时为设置值 −1，>14 时为设置值 −2；默认设置下为 13 px）及配套的 `--dsh-content-font-delta-secondary`，供表格变体与比正文低一档的流内行使用。紧凑的小号文本与代码变体保持固定字号。阶梯之外，用户气泡与 composer 草稿直接读取正文字号变量对，流内行的标题及摘要读取低一档变量对。该表还持有阴影阶（`--dsw-shadow-lv*`）、菜单/卡片毛玻璃滤镜（`blur(16px) saturate(108%)`）与 elevation token：每一档都组合可重绑的 0.5 px 发丝线、适配主题的内缘高光和柔和投影。菜单使用独立的亮暗发丝线和柔和投影；其他绘制 `--dsw-specific-menu` 的高层级卡片应用 `backdrop-filter: var(--dsw-menu-backdrop-filter)`。内层内容可以使用半透明染色底，但不重复模糊。设置弹窗另用 90–92% 的材质填充与 22px 模糊；内置亮暗配色以暖中性色表面搭配低饱和鸢尾紫强调色。不支持 blur 或用户减少透明度时使用不透明主题底色（[决定](../../../.agents/notes/implemented/feature/2026-09-17-compact-translucent-menu-surfaces.zh.md)）。

### 滚动条重新绑定

`scrollbar.css` 在 `body` 上把 `--dsh-scrollbar-thumb` 与 `--dsh-scrollbar-thumb-hover` 绑定到 l1 基础表面 token；高层级表面（菜单、浮层、对话框）在自己的容器上把它们重新绑定为 l2 token；这组变量的另一个合法目标是 `transparent`（ui-sidebar 在指针不在栏内时就这样重新绑定自己的列）。WebKit 系浏览器默认使用 5px 的 `--dsh-scrollbar-width`，并读取 `--dsh-scrollbar-thumb-border` 与 `--dsh-scrollbar-track-margin`；滚动表面可重新绑定它们，在较窄的可见滑块外保留较宽的拖动区域，或让轨道避开圆角两端。两条渲染路径在构造上互斥：Firefox 走 `@supports not selector(::-webkit-scrollbar)` 内的标准细滚动条，WebKit 系引擎走伪元素，因此几何与 hover 定制只经由伪元素路径生效。

### 偏好持久化

在 loopback 浏览器上，服务先以 schema 默认值立即提供自身，随后加载 `ui-theme` 命名空间，并把每次通过的外观变更经 Host settings API 写入。收到推送的设置变更时或重连后都会重新拉取该命名空间。非 loopback 页面不会创建该 Host-backed scope。该持久化边界由 [Host 支撑的偏好笔记](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.zh.md) 拥有。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖布局展示转换器、token 消费方与样式规则。

- [ui-layout](../ui-layout/README.zh.md)——应用解析后主题快照的展示转换器。
- [ui-sidebar](../ui-sidebar/README.zh.md)——滚动条重新绑定约定的消费方。
- [ui-conversation](../ui-conversation/README.zh.md)——为 composer 席位消费 `--dsh-scrollbar-width` 的消费方。
- [Web 样式](../../../docs/web-styling.zh.md)——Web 客户端组件的权威样式规则。
- [Host 支撑的偏好](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.zh.md)——持久化边界决策。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义主题扩展表面与颜色权威；它们是当前包约束。

- **第三方主题是扩展点，不是产品**：注册主题意味着覆盖同名别名变量；目前不会验证一组覆盖是否完整。
- **token 样式表是颜色值的唯一权威来源**：设计系统中缺失的值会有意不补入；一律采用最接近的语义 token，设计负责人批准的新增值须在同一变更中以一个静态尺度层级与一个语义别名的形式进入。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。settings scope 校验并发布持久 theme section，注册表与自身变更同步发出 `theme/change`；存储与注册表的一致性由本包针对 Host、scope 与服务行为的测试直接覆盖。
