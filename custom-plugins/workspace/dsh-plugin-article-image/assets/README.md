# Article image artwork

English | [中文](README.zh.md)

`article-image.svg` is the small monochrome plugin mark. `src/client/artwork.js` supplies the matching navigation mark and article-to-picture empty-state illustration. Their colors come from the active AutoFlow semantic tokens; no separate dark palette is required.

`article-flow-animated.svg` is a standalone light-theme preview exported from the runtime artwork. During retrieval, the workbench animates the existing paper, picture, arrow and sparkles using theme motion tokens. Reduced motion keeps the illustration static. It does not show estimated progress.

`article-image-logo.png` is the transparent brand source generated with the built-in image_gen tool. `article-image-logo.webp` is its 512 × 512 delivery version, encoded losslessly after resizing and shared by the package icon and Client. The Client embeds it at build time, so it does not depend on an external image URL. The package check rejects icons larger than the Host's 256 KiB limit. It appears only as a compact brand mark; all interactive control colors remain token-owned.

Generation prompt:

> Use case: logo-brand. Asset type: production plugin logo for an editorial article-to-image workbench in AutoFlow. Create one refined standalone symbol, no words. The concept is a single sheet of editorial paper becoming a picture: a compact rounded square page silhouette, three short text lines on its upper left, an elegant folded corner at top right, and a simple landscape aperture in the lower half with a small sun. Flat precision vector-like geometry with a very subtle dimensional paper fold, crisp at small sizes. Restrained iris blue and soft periwinkle accents with neutral porcelain paper, suitable for both dark charcoal and white application surfaces. Centered isolated mark filling about 75 percent of a square image. Actual transparent background. No enclosing app tile, no lettering, no watermark, no gradients outside the mark, no extraneous objects, no drop shadow outside the silhouette.
