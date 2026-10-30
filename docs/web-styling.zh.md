# Web UI 样式参考

[English](web-styling.md) | 中文

本文规定浏览器客户端包的样式职责归属与组件规则。当前 token 值位于 [`packages/client/ui-theme/src/styles/`](../packages/client/ui-theme/src/styles/)；本文不重复这份由源码生成的清单。

## 职责归属

[`ui-theme`](../packages/client/ui-theme/README.zh.md) 负责 `--dsw-*` 静态色阶、语义别名、排版、动效、渐变、阴影、滚动条样式以及明暗主题偏好。[`ui-layout`](../packages/client/ui-layout/README.zh.md) 将解析后的主题快照应用到文档。功能包使用语义别名，不得另行定义全局主题。

全局样式表归 `ui-theme/src/styles/` 所有。组件样式以 CSS Modules 形式放在组件旁。当某个值属于该组件的布局或呈现约定时，组件可以定义局部自定义属性；共享颜色、排版、层级和动效属于主题包。

<a id="component-rules"></a>
## 组件规则

- 重新设计控件样式之前先复用控件：[ui-primitives 组件目录](../packages/client/ui-primitives/README.zh.md#component-catalog)是唯一跨功能包的通道，有意的视觉差异应作为那里的一个 prop，而不是另起一份拷贝（[参考](../packages/client/ui-primitives/README.zh.md)）。
- 使用 CSS Modules 和 `clsx`；不得添加组件库或 Tailwind。
- 功能组件使用 `--dsw-alias-*` 语义 token。不得复制静态色板值或在其中写入颜色字面量。
- 功能组件 CSS 不得包含主题选择器。明暗主题覆盖属于主题所有方。
- 字体大小必须与行高配对；已有角色匹配时使用主题排版变量。
- 当组件约定要求保留列结构时，源码文本、终端输出和 diff 行不得换行；使用共享滚动条样式，不得定义组件专用滚动条选择器。
- 呈现规则写在 CSS 中。React 内联样式可以传递组件局部自定义属性值，但不得编码主题分支。
- 插件样式表中的相对 `url()` 指向本包 `src/client/assets/` 中的文件，构建会将其改写为[包资源](../packages/client/AGENTS.md#dependency-declaration) URL。`data:`、`#fragment`、以 `/` 开头、带 scheme 的引用以及空 `url('')` 引用保持不变，带片段或查询串的相对文件引用会让构建失败，依赖包中的样式表不会被改写。
- 将 `:hover` 选择器放在 `@media (hover: hover)` 内，不依赖视口宽度。选中、展开、按下和键盘焦点样式保留在该条件之外。无 hover 时，操作保持可见或通过明确控件访问；打开纯悬停预览的指针事件处理忽略触摸。保留清晰可见的键盘焦点和减少动态效果行为。
- 支持的引擎上，圆角继承 ui-theme `corner-shape.css` 的全局超级椭圆平滑。每个正圆 `border-radius`（`50%`、`100%` 或胶囊半径）必须配对 `corner-shape: round`，使圆形与胶囊保持圆弧；ui-theme 的 corner-shape spec 强制这一配对。
- 高层级表面（菜单、浮层、对话框、面板、悬浮按钮、输入框）设 `border: 0` 并使用 `box-shadow: var(--dsw-elevation-panel)`、`var(--dsw-elevation-prominent)`、菜单专用的 `var(--dsw-elevation-menu)` 或输入框专用的 `var(--dsw-elevation-soft)`（更大模糊、更低透明度）：0.5px 发丝描边是第一层投影，`--dsw-elevation-stroke-color` 可按表面或状态重绑或抑制描边。不得将 `--dsw-alias-border-*` border 与 lv/elevation 投影配对——ui-theme 的 elevation spec 会拒绝；状态色 border（warn 面板）保持真 border。
- 对话、设置、插件管理和侧栏中的卡片外壳以侧栏引导卡片为基准：亮色卡片采用 76% 暖白填充与略清晰的柔和阴影，暗色卡片保留 88% 炭灰填充和细亮边。亮色共享菜单采用 68% 填充和更轻的阴影，让背后模糊的内容仍隐约可见；暗色表面保持较稳的填充以便阅读。共享材质使用`--dsw-specific-menu`、`backdrop-filter: var(--dsw-menu-backdrop-filter)`（`blur(16px) saturate(108%)`），以及带主题适配内缘高光和柔和阴影的 elevation token。设置弹窗使用 90–92% 的填充和 22px 模糊；内置亮暗主题使用暖瓷白与墨灰画布、低饱和鸢尾紫强调色和中性阴影。内层详情卡使用半透明染色底，不再重复模糊，让外壳成为唯一玻璃层。代码/数据画布、消息气泡和控件保留各自语义底色，以维持内容可读性与交互对比。不支持 blur 或系统启用 `prefers-reduced-transparency` 时改用不透明主题底色；macOS 透明桌面窗口仍使用近不透明填充。包含 fixed 定位浮层的表面把材质绘制在隔离的背景伪元素上，避免滤镜改变这些浮层的包含块。共享下拉菜单采用紧凑 `Menu` 几何；功能包自有菜单内容可以不同，但不得重新实现材质或滚动条（[决定](../.agents/notes/implemented/feature/2026-09-17-compact-translucent-menu-surfaces.zh.md)）。
- 下拉、上下文、子菜单和选择菜单使用 `Menu` 或 `MenuSurface`，由共享组件统一使用 `--dsw-menu-surface-fill`、`--dsw-menu-backdrop-filter` 和菜单专用发丝线及投影；功能 CSS 不重定义这些 token。独立的任务与会话树菜单使用 `--dsw-menu-standalone-fill` 和相同投影，`TaskMenu` 与 `ClockPicker` 仍是日程功能自有的例外。macOS 上，`MenuSurface` 在菜单范围内挂载底层，让 Chromium 能在原生 vibrancy 上模糊页面内容；独立菜单使用接近不透明的填充。不支持模糊或减少透明度时，菜单使用不透明底色。其他浮层保留 `--dsw-specific-menu` 填充。模态遮罩使用主题定义的轻微 `--dsw-mask-blur`，Desktop 管理的浮层不对父页面施加滤镜。
- 使用中性 `--dsw-alias-border-*` token 的平面边框与分割线一律 `0.5px`——按钮、输入框、卡片、行分割线，以及以填充盒绘制的分隔线（菜单分隔、对话标题栏接缝、markdown `hr`、竖向轨道线）共用发丝线粗细，Chromium 将其绘制为一个设备像素。dashed 记号与状态色 border 保持 1px；spinner 圆环经 spec 的显式豁免保留原宽度。更宽的中性 solid border 会被 ui-theme elevation spec 拒绝。
- 可点击产物链接（Markdown 锚点、正文文件引用、网页来源与抓取链接、产物 chips、workflow 成员链接）经 `--dsw-alias-link` 着色、`font-weight: 500`，默认无下划线，hover/focus 时为 3px offset 的点状下划线。紧凑 Thinking Markdown 保持 tertiary 文字色和默认点状下划线（[紧凑展示](../packages/client/ui-primitives/README.zh.md#rendering-agent-output)）。带文字的锚点另以 ui-primitives 的 `LinkIconMedium` 分类图形（随 `currentColor`）作前置；目的地是已知外部站点时改用该站点自己的标记而非地球；workflow 成员链接与只包图片的锚点不带图形，工具行文件链接保持其灰色点线示能。

<a id="input-capabilities"></a>
## 输入能力

`pointer` 与 `hover` 描述浏览器选定的主指针，`any-hover` 则考虑所有可用指针。三者都不检测物理键盘。

- `(pointer: coarse)` 用于依赖指针精度的呈现，例如适合触摸的控件和文本框尺寸。
- CSS 悬停效果保留在 `(hover: hover)` 下，使以触屏为主的布局无需悬停也能使用。
- JavaScript 悬停预览在接受 mouse 进入事件时使用 `(any-hover: hover)`，并忽略 touch 进入事件。因此，即使触屏仍是主指针，外接鼠标也能打开预览。如果通过 `any-hover` 启用全部 CSS 悬停样式，触摸产生的 `:hover` 状态也会应用这些样式。

混合输入设备上，鼠标预览可以出现，而基于主指针的 CSS 悬停样式保持关闭。键盘焦点和快捷键提示根据实际键盘交互显示，不依赖这些能力查询；共享行为见 [Menu 与输入方式](../packages/client/ui-primitives/README.zh.md#input-modality)。

<a id="corner-radii-and-settings-cards"></a>
## 圆角与设置卡片

圆角尺度、组件尺寸映射、正圆与胶囊例外、嵌套 hover，以及设置卡片的底色与描边统一由 [DSH 统一圆角规范](ui-radius.zh.md)定义。

## 变更系统

在所属 `ui-theme` 样式表中添加或修改共享 token，然后在功能包中使用其语义别名。公共样式约定发生变化时，更新所属包的参考文档。视觉行为遵循[测试策略](testing.zh.md)；[已归档的样式系统 Agent Note](../.agents/notes/archived/process/2026-07-19-web-styling-system.md) 记录框架依据。
