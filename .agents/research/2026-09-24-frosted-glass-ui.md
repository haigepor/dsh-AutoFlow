# 毛玻璃菜单与卡片：效果边界和优化建议

检索日期：2026-09-24。范围：DeepSeek Harness 客户端中的 CSS 毛玻璃菜单、浮层和卡片。本文区分标准或文档事实与视觉建议；建议中的数值是待对比的设计候选，不是 WCAG、Apple 或 CSS 标准规定值。

## 结论摘要

截图里的下拉层看起来接近不透明，但单凭截图无法区分“没有命中毛玻璃规则”“过滤器采样范围被祖先截断”“底色遮住大部分背景”或“背景本身太平”；应先检查真实菜单面板的计算样式和背后像素，再调 blur 数值。MDN 明确说明，`backdrop-filter` 处理元素后方已绘制的像素，元素自身或其背景必须透明或半透明才能看见效果。[MDN：`backdrop-filter`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter)

当前 DSH 主题给普通深色界面的 `--dsw-specific-menu` 使用 `rgba(48, 49, 54, 0.5)`，浅色为 `rgba(248, 249, 250, 0.58)`；共享过滤器为 `blur(40px) saturate(150%)`。[design-platform.css](../../packages/client/ui-theme/src/styles/design-platform.css) [gradient-shadow-text.css](../../packages/client/ui-theme/src/styles/gradient-shadow-text.css) 但 macOS 桌面有一个特例：Electron 透明窗口下 Chromium 的根表面无法提供可供该过滤器模糊的窗口内容，因此主题把菜单/卡片底色提高到 alpha 0.94，避免底下文字透出。[base.css](../../packages/client/web/src/base.css) 若该平台覆盖正在生效，背景内容只贡献约 6% 的直通信号，视觉上接近实色；这是根据 alpha 合成关系作出的推断，不是截图已证明的运行平台或实际计算值。

毛玻璃适合用于菜单、popover、工具栏等浮在内容之上的功能层，不适合作为所有内容卡片的同等强度纹理。Apple HIG 将 Liquid Glass 定位在导航和控制层，建议在内容层使用标准材质、少量用于重要功能表面，并避免多层玻璃相叠；这是一项原生平台设计原则，不是对 DSH CSS 的强制实现规范。[Apple HIG：Materials](https://developer.apple.com/design/human-interface-guidelines/materials)

## 截图的排查顺序

先在开发者工具中选中展开后的**菜单面板本体**，而不是触发下拉的按钮或列表行，检查 `background-color` 是否带 alpha、`backdrop-filter` 是否解析为非 `none`，以及是否有后绘制的实色子层覆盖过滤背景。CSS Modules 的哈希类名只是构建结果，定位时应回到组件源类和对应样式文件。

然后确认面板后方确实有可采样内容。纯色深色页面没有足够纹理让 blur 显形；blur 会弱化边缘细节，但不会凭空产生图案或更大的色差。因此，在一块单色底上，玻璃可能只表现为轻微色偏，这是视觉推断。建议在截图中同时放入纯色区域和有文字/色块的区域，比较同一面板。

检查从面板到根节点之间的祖先。MDN 说明，`opacity` 小于 1、非 `none` 的 `filter` 或 `backdrop-filter`、mask/clip、非 `normal` 的混合模式，以及对这些属性的 `will-change`，都可能建立 backdrop root；过滤器只能读取最近 backdrop root 之内的像素。MDN 特别指出，祖先 `opacity: 0.9` 会造成过滤器看似失效的常见情形。[MDN：backdrop root](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter#backdrop-root)

若截图来自 macOS，还应检查 `html[data-platform='darwin']` 是否命中；仓库对此平台有透明窗口专用的近不透明回退。截图文件的 Windows 本地路径本身不能证明应用运行在哪个平台，也不能证明 Electron 的 `data-platform` 值。[base.css](../../packages/client/web/src/base.css)

快速区分规则问题与材质问题的方法，是暂时将面板背景设为低 alpha 的醒目色并使用很小的 `blur()`，确认下方像素是否进入合成；然后恢复设计 token，并分别比较底色 alpha、blur 半径和饱和度。检查 `opacity` 时应避免把它设在整个面板上：MDN 说明 `opacity` 会作用于面板全部内容，包括文字和图标；只想调底色时应给 `background` 使用 alpha 通道。[MDN：`opacity`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/opacity)

## 推荐的材质层级

| 使用位置 | 建议 | 依据性质 |
| --- | --- | --- |
| 菜单、popover、悬浮工具条 | 一个半透明外壳承载 blur 与 elevation；文字多或背景复杂时先保可读性。 | Apple HIG 指出 regular 变体会模糊并调整背景亮度以维持易读性，适用于文字较多的 alerts、sidebars、popovers；“一个外壳”是本项目的视觉建议。 |
| 照片、视频等丰富媒体上方的短控件 | 可测试更透明的 clear 风格；亮背景上先确认标签对比度，必要时为背景增加暗化。 | Apple HIG 将 clear 用于视觉丰富的媒体背景，并建议亮背景可考虑 35% 暗化层。 |
| 页面中的普通内容卡片、代码/数据区 | 保留内容层自身的表面；不要让每个嵌套卡片都变成高强度玻璃。 | Apple HIG 建议 Liquid Glass 与内容层区分，并避免在内容层使用或过度应用；把标准材质映射为 DSH 的既有实色/低对比卡片是视觉建议。 |
| 玻璃上的按钮、选中行 | 用轻量状态填充、图标和现有 elevation/状态 token 表达层级，避免再叠一张玻璃面板。 | Apple HIG 的避免玻璃层叠建议；状态具体样式需按 DSH token 校准。 |

Apple HIG 还指出，较厚、较不透明的材质通常更利于细小文本对比；较薄、较透明的材质更容易保留背景语境。它建议 regular 作为一般用途、clear 只用于丰富背景，并提示系统设置可能改变材质呈现。[Apple HIG：Materials](https://developer.apple.com/design/human-interface-guidelines/materials)

## 视觉调参建议

以下是受截图启发的 A/B 测试值，不是标准答案：针对一个深色菜单，固定文字、阴影和底层画面，先比较底色 alpha `0.40 / 0.50 / 0.60`；再单独比较 `blur(24px)` 与当前 `blur(40px)`；最后比较 `saturate(115%) / 130% / 150%`。一次只改变一个维度，并同时观察纯色背景、文字背景和色彩丰富背景。若减小 alpha 导致文字对比不足，应提高底色不透明度或只在高风险内容区域加局部暗化，不要用更强 blur 代替对比度。

推荐把视觉线索分成几层来校准：半透明染色底负责材料本身和文本可读性，backdrop blur 负责压低背景细节，轻微饱和度变化用于保留背景色彩，细微边缘高光或现有 elevation stroke 用来勾出轮廓，外部柔和阴影负责与页面内容分层。边缘高光和阴影分工是视觉建议，Apple/WCAG 没有规定对应 CSS 数值；DSH 已有 elevation stroke/shadow token，应用时应沿用该套 token，而不要再叠一圈醒目的实线边框。[ui-theme README：elevation token](../../packages/client/ui-theme/README.md)

建议默认把最明显的玻璃保留给最靠前的菜单/临时浮层；普通内容卡片采用更轻的底色或标准表面。菜单内部的 hover/selected 行可以有明确状态底色，但不应在每一行再使用一次 backdrop blur。这样的层次比“所有页面、所有卡片都同强度玻璃”更容易形成前后顺序；这是基于 Apple 的功能层/内容层区分作出的设计建议。

## 可读性、辅助功能与平台回退

WCAG 2.2 AA 要求普通文本与背景对比至少 `4.5:1`，大号文本至少 `3:1`；用于识别组件、状态或图形含义的必要非文本视觉信息与相邻颜色至少 `3:1`。[WCAG 2.2：1.4.3 Contrast (Minimum)](https://www.w3.org/TR/WCAG22/#contrast-minimum) [WCAG 2.2：1.4.11 Non-text Contrast](https://www.w3.org/TR/WCAG22/#non-text-contrast) 毛玻璃面板的对比度要在最终合成后的背景上检查，而不能只比较 CSS 中的前景/底色色值；这是将 WCAG 对前景与背景的要求应用到半透明合成后的工程结论。深色与浅色主题、选中/悬停状态都要分别检查。

系统减少透明度设置应让材质退化为不透明或更实的表面。MDN 记录了 Windows、macOS、iOS 的相关偏好，但当前 `prefers-reduced-transparency` 仍标记为 Limited availability / 非 Baseline；可将它作为增强分支，不能把它当作唯一回退机制。[MDN：`prefers-reduced-transparency`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/prefers-reduced-transparency) Apple 也建议实际测试“减少透明度”与“增加对比度”设置组合。[Apple：Testing system accessibility features](https://developer.apple.com/documentation/accessibility/testing-system-accessibility-features-in-your-app)

`prefers-reduced-motion` 表达的是减少非必要运动，不等同于减少透明度。对菜单开合、位移、缩放和背景动画应在此偏好下缩短或移除动效；静态 blur 不需要仅因 reduced-motion 自动关闭。[MDN：`prefers-reduced-motion`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/prefers-reduced-motion) “保留静态 blur”是对该媒体特性语义的应用建议。

性能方面，WebKit 对 `backdrop-filter` 的实现说明指出，处理背景会增加渲染 pass，硬件加速可提升效率，但仍应只在最必要的位置使用；该文章较旧，说明的是机制和注意事项，不代表当前所有设备的实测成本。[WebKit：Introducing Backdrop Filters](https://webkit.org/blog/3632/introducing-backdrop-filters/) 对 DSH 的实用建议是限制大面积滚动列表内的独立 blur 面板数量，避免持续动画 blur 半径，并在目标移动设备上实测滚动和弹出时的帧率；如果出现掉帧，保留半透明/不透明填充、状态边缘和 elevation，移除昂贵过滤器即可。

MDN 将 `backdrop-filter` 标记为 Baseline 2024，并说明旧设备或浏览器仍可能不支持。[MDN：`backdrop-filter` 浏览器支持](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter#browser_compatibility) 因此先声明可读的普通底色，再用 `@supports` 覆盖为半透明加 blur；在不支持 CSS 属性或用户减少透明度时，界面仍应保持不透明度、状态和文字对比，不应依赖 blur 传达交互状态。

## 建议的验收观察表

| 场景 | 观察项 |
| --- | --- |
| 深色与浅色主题 | 面板相对页面确实半透明；标题、选项、勾选图标仍有足够对比。 |
| 纯色与丰富背景 | 两类背景都能看出面板边缘；丰富背景不因高饱和而干扰菜单文字。 |
| 普通/选中/悬停状态 | 状态可区分，不单靠颜色，选中符号没有被底色或 blur 弱化。 |
| 有无 blur 支持、减少透明度 | 普通填充回退可读，透明度偏好能退化为实色。 |
| reduced-motion 与移动设备 | 打开/关闭动效符合偏好；滚动和弹出无可感知卡顿。 |
| 多层内容 | 一个浮层玻璃压在内容层上；嵌套卡片和行项不重复叠玻璃。 |

## 来源

- [Apple Human Interface Guidelines：Materials](https://developer.apple.com/design/human-interface-guidelines/materials)：材质层级、regular/clear 用途、透明度与可读性建议，2025 年 9 月更新。
- [Apple：Testing system accessibility features in your app](https://developer.apple.com/documentation/accessibility/testing-system-accessibility-features-in-your-app)：减少透明度和增加对比度的验证方式。
- [W3C：Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/)：AA 文本及非文本对比度标准。
- [MDN：`backdrop-filter`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter)：透明背景要求、backdrop root 规则与浏览器支持情况。
- [MDN：`opacity`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/opacity)：元素整体透明度对其子内容的影响。
- [MDN：`prefers-reduced-transparency`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/prefers-reduced-transparency) 与 [MDN：`prefers-reduced-motion`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/prefers-reduced-motion)：系统偏好语义与透明度媒体特性的兼容性状态。
- [WebKit：Introducing Backdrop Filters](https://webkit.org/blog/3632/introducing-backdrop-filters/)：渲染 pass 与性能注意事项；文章较旧，未被用于推断当前设备的量化性能。
