# 文章生图素材

[English](README.md) | 中文

`article-image.svg` 是单色插件小图标。`src/client/artwork.js` 提供同构的导航图标，以及文章转为图片的空状态插画。颜色来自当前 AutoFlow 语义 token，无需单独维护深色调色板。

`article-flow-animated.svg` 是从运行时图形导出的浅色独立预览版。抓取时，工作台使用主题动效 token 驱动现有纸页、图片、箭头和星点；减少动态效果时保持静态，不显示估算进度。

`article-image-logo.png` 是通过内置 image_gen 工具生成的透明品牌原图。`article-image-logo.webp` 是其 512 × 512 分发版本，缩小后以无损格式编码，供插件图标和 Client 共用。Client 在构建时嵌入此图，不依赖外部图片地址。插件检查会拒绝超过 Host 256 KiB 限制的图标。它仅作为紧凑品牌标记显示，所有交互控件的颜色仍由 token 管理。

生成提示词：

> Use case: logo-brand. Asset type: production plugin logo for an editorial article-to-image workbench in AutoFlow. Create one refined standalone symbol, no words. The concept is a single sheet of editorial paper becoming a picture: a compact rounded square page silhouette, three short text lines on its upper left, an elegant folded corner at top right, and a simple landscape aperture in the lower half with a small sun. Flat precision vector-like geometry with a very subtle dimensional paper fold, crisp at small sizes. Restrained iris blue and soft periwinkle accents with neutral porcelain paper, suitable for both dark charcoal and white application surfaces. Centered isolated mark filling about 75 percent of a square image. Actual transparent background. No enclosing app tile, no lettering, no watermark, no gradients outside the mark, no extraneous objects, no drop shadow outside the silhouette.
