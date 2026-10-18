# Metrópoles 与 R7 修复及 3080 验收

日期：2026-10-18（Asia/Shanghai）。工作区：`C:/Users/haige/Desktop/deepseek-harness-master`。本次只通过实际 3080 工作台重新获取第 4、21 篇，并核对其余 26 篇既有记录及全体文件完整性；不声称本次重新联网抓取了全部 28 篇。

## 结论

**Observed：目标缺陷修复验收 PASS，文章完整性评级仍为 partial。** Metrópoles 公开视频封面由失败变为成功；R7 新增 131 条公开字幕，时间及文字逐条吻合独立读取的 WebVTT。两篇已有正文、列表、图注及图片说明按原顺序保留，原有 97 张图片内容哈希全部一致，当前共 98 张 ready 图片、0 张失败图片。视频动态画面与未提取的 Instagram 嵌入内容不属于已获取正文，继续明确提示 partial；没有真实模型分析或生图调用。

## 失败根因与修复

| 对象 | Observed 根因 | 修复及代码依据 |
|---|---|---|
| Metrópoles 封面 | 发布地址 `assets-jpcust.jwpsrv.com/thumbs/yOFDAjh3-720.jpg` 301 到 `cdn.jwplayer.com/v2/media/yOFDAjh3/poster.jpg`，再 302 回 `assets-jpcust.jwpsrv.com/thumbnails/4hwo26c5-720.jpg`，最终 200。原有同源限制正确拒绝第一跳，属于受控 CDN 跳转缺配置。 | `src/capture.js:41`、`src/capture-media.js:79`：站点原图会话配置两条精确 HTTPS origin 边，每跳仍固定并校验公网地址；普通页面请求保持同源限制。跨源不透传凭据，跳转响应字节累计扣费。 |
| R7 字幕缺失 | 公开 WebVTT 存在；原生 video 曾为 `visibility:hidden`，且实际工作台多轮 DOM 中没有 track。依赖 track 是否初始化不能稳定获取文字。 | `src/capture-captions.js:61`：只读取配置声明的公开字幕及指定主机，完整解析后加入媒体位置；隐藏祖先、广告及畸形字幕不作为正文。 |
| R7 元数据回退失效 | 浏览器快照准确复现：Patchright 默认隔离执行上下文看不到页面的 `Fusion.globalContent`。仅用 fake renderer 的单元测试不足以发现它。 | `src/capture-renderer.js:251`：按当前安装 API 的第四参数显式选择主上下文；只沿配置路径读取自有数据属性，不调用 getter。canonical 必须等于当前文章 URL，正文内锚点唯一；仅输出选定字段，不扫描推荐视频或执行页面源码。 |
| R7 封面/说明偶发缺失 | 播放器未初始化时封面或 title 不稳定；已有 DOM 图片还可能使 video poster 去重分支跳过。 | `src/capture-captions.js:15`：从已核对身份的当前文章 `promo_image` 补齐公开封面和空说明，匹配精确 URL，排除广告，不覆盖不同封面及既有标签。获取图片仍经普通传输预算和真实解码。 |

Patchright 隔离世界行为见[官方 Node 文档](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs#extended-patchright-api)；本机 `node_modules/.pnpm/patchright-core@1.64.1/node_modules/patchright-core/types/types.d.ts:137` 明确了 `evaluate(function,arg,options,isolatedContext)`，本次按安装源码而非旧用法接入。

## 最终实际结果与耗时

| 文章 | 原结果 | 当前结果 | 排队 | 运行总耗时 | 渲染/读取 | 抽取及字幕 | 图片与解码阶段 |
|---|---|---|---:|---:|---:|---:|---:|
| Metrópoles #4 | 38 块；2 张 ready、1 张 failed | 38 块，24 段、5 标题、3 张 ready；新增封面 720×1280，126191 字节 | 0.074s | 54.769s | 28.276s | 2.561s | 20.695s |
| R7 #21 | 10 块；7 段、2 标题、1 张封面 | 143 块，140 段、2 标题、1 张封面；其中 131 段为带时间的字幕 | 0.177s | 64.974s | 59.995s | 3.261s | 1.602s |

阶段耗时来自持久化事件时间差；运行总耗时还包含发布、状态写入及阶段间开销，因此阶段之和不等于总耗时。本次是外网实测样本，不是稳定延迟保证。R7 主要耗时在页面渲染与资源等待。

R7 字幕来源返回 11770 字节、131 条 cue，覆盖 `00:00:00.000–00:07:01.000`。独立拆分原始 WebVTT 后，131 条起止时间与逐条文本 SHA-256 全部一致；合并文本 SHA-256 为 `3f3a4b5a592174465b1d3fc2425c33f7814907177577eb49513771f46511be55`。这是已发表字幕的可获取文字，不是模型转写或补写。

## 3080 页面与原图证据

通过实际“处理所选”按钮启动两篇，读回实际鉴权 API 和持久化快照。R7 页面实际显示 143 块、131 条带时间文字及 WebVTT 来源链接，960×540 封面实际解码成功；Metrópoles 三张图片均实际解码成功，四个图片 asset 路由返回 200，读取字节的哈希均等于快照记录。诊断中显示“公开字幕获取完成”；本轮页面控制台 0 个错误、0 个警告。`generation.available=false`，原因 `phase-one-review-only`。详细机器证据见 [ui.json](ui.json)。截图保存在本次私有备份目录中的 `r7-ui.png`、`metropoles-ui.png`。

## 28 篇不退步核对

对所有既有快照重新校验 schema、文件封装哈希、语义哈希及所有 ready 图片实际文件字节。正文、嵌套列表、图块说明按去除临时 block ID 后的原有块顺序比较；字幕插入不能掩盖原块遗漏。其余 26 篇的来源内容与快照引用不变；其中第 1 篇在本次按钮操作之前另有一次重试，仅 run/revision 改变，仍为 `article-restricted`，没有覆盖该并发操作。

| 序号 | 站点 | 当前评级/错误 | 原块顺序保留 | 原图保留 / 原图基线 → 当前 ready |
|---:|---|---|---:|---:|
| 1 | www1.folha.uol.com.br | article-restricted | 0/0 | 0/0 → 0 |
| 2 | www1.folha.uol.com.br | article-restricted | 0/0 | 0/0 → 0 |
| 3 | www1.folha.uol.com.br | article-restricted | 0/0 | 0/0 → 0 |
| 4 | www.metropoles.com | partial | 38/38 | 2/2 → 3 |
| 5 | www.correiobraziliense.com.br | needs-review | 5/5 | 1/1 → 1 |
| 6 | www.correiobraziliense.com.br | needs-review | 15/15 | 1/1 → 1 |
| 7 | www.otempo.com.br | needs-review | 31/31 | 8/8 → 8 |
| 8 | guia.folha.uol.com.br | needs-review | 63/63 | 20/20 → 20 |
| 9 | www1.folha.uol.com.br | article-restricted | 0/0 | 0/0 → 0 |
| 10 | guia.folha.uol.com.br | needs-review | 72/72 | 20/20 → 20 |
| 11 | g1.globo.com | needs-review | 27/27 | 4/4 → 4 |
| 12 | www.gov.br | needs-review | 32/32 | 3/3 → 3 |
| 13 | www1.folha.uol.com.br | article-restricted | 0/0 | 0/0 → 0 |
| 14 | www1.folha.uol.com.br | article-restricted | 0/0 | 0/0 → 0 |
| 15 | canaltech.com.br | needs-review | 50/50 | 9/9 → 9 |
| 16 | www.cultura.sc.gov.br | needs-review | 16/16 | 1/1 → 1 |
| 17 | www.lance.com.br | needs-review | 13/13 | 2/2 → 2 |
| 18 | www.gov.br | needs-review | 7/7 | 1/1 → 1 |
| 19 | www.cnnbrasil.com.br | needs-review | 55/55 | 13/13 → 13 |
| 20 | www.correiobraziliense.com.br | needs-review | 21/21 | 3/3 → 3 |
| 21 | record.r7.com | partial | 10/10 | 1/1 → 1 |
| 22 | www.estadao.com.br | needs-review | 51/51 | 3/3 → 3 |
| 23 | www.bcb.gov.br | article-short | 0/0 | 0/0 → 0 |
| 24 | www.bcb.gov.br | needs-review | 8/8 | 0/0 → 0 |
| 25 | www.bcb.gov.br | needs-review | 1/1 | 0/0 → 0 |
| 26 | www.gov.br | needs-review | 14/14 | 2/2 → 2 |
| 27 | www.gov.br | needs-review | 16/16 | 1/1 → 1 |
| 28 | www.gov.br | needs-review | 11/11 | 2/2 → 2 |

共 21 份正文快照：19 份 needs-review、2 份 partial；既有 7 条失败保持为 6 条 article-restricted、1 条 article-short。本次没有绕过登录或付费限制。早期复测曾出现同一 Metrópoles 图片 URL 的 JPEG 文件哈希不同，独立解码后的全部 RGB 像素和尺寸相同；最终这次 97 张原图文件哈希均与原基线一致，不依赖像素等价放宽验收。

## 测试与检查

- `pnpm test`（工具包）：29 文件、412 测试通过。
- `pnpm test`（父插件）：17 文件、157 测试通过。
- `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/article-image.e2e.ts`：1/1 通过，50.08s；真实 Chromium 与假模型服务，字幕场景故意无 DOM track，覆盖主上下文读取及封面恢复。更新可见结果快照。
- 插件 `pnpm run check`、两组双语文档配对检查及 `git diff --check` 通过。
- 定向 RED→GREEN 覆盖未知 CDN/私网/凭据隔离/跳转字节预算、字幕身份/主机/锚点、隐藏广告、字幕去重、畸形整份拒绝及预算、取消与 dispose、无播放器文章不误判、未初始化封面和空说明。
- 浏览器测试发现一次 UI 尚未接收到后端阶段更新的竞争，已等待实际标题到达预期状态；没有降低预期或延长任务总超时。较早一次 180 秒超时的输出已保留私有目录，本轮已通过，不将其归因于未证实的原因。

## 修改范围、影响与回滚

| 文件组（均位于工作区） | 用途与影响 |
|---|---|
| 工具包 `src/capture.js`、`capture-renderer.js`、`capture-embeds.js`、`capture-media.js`，新增 `capture-captions.js` | 声明式字幕/封面来源及原图 CDN 例外；默认未配置站点不启用。新增字幕改变来源哈希，必须重新来源审核和方案审核。 |
| 工具包新增 `test/capture-captions.test.js`、`caption-metadata.test.js`、`image-redirects.test.js` | 26 项针对性测试，含真实故障 RED 证据。 |
| 插件 `src/client/locales/en.json`、`zh.json` 及生成的 `client.js` | 三项字幕诊断事件本地化，无布局重设计。 |
| `apps/web/tests/article-image.e2e.ts` 及 owner-local snapshot | 无 DOM track 的真实浏览器回归及 UI 阶段等待。 |
| 工具包 README 双语三件套、既有 article-image-workflow 升级指南三件套 | 部署参数、安全限制、来源重新审核及旧配置读取器降级说明。 |
| 本报告目录 | 脱敏测试、UI、配置与范围证据。 |
| 外部产品配置 `C:/Users/haige/.dsh/profiles/web/cordis.patch.yml` | 仅增加 R7 字幕/封面字段与 Metrópoles 两条 CDN 边；代理、DoH、模型及其他既有配置保持原值。具体适配器见 [capture-config.json](capture-config.json)。 |

已保留全部既有未提交改动，没有提交、reset 或覆盖其他文件。本次精确备份位于 `C:/Users/haige/AppData/Local/Temp/article-video-fix-WF687m`：`before/` 保存本轮改动文件原始未提交字节，`cordis.before.yml` 保存产品 profile，`state.before.json` 保存业务基线；失败中间实验也单独保留。回滚只恢复本轮列出的既有文件，并仅删除本轮新增文件，不恢复整个 Git 工作区，也不覆盖并发业务操作。范围比对覆盖本轮开始时 15283 个文件，详细结果见 [scope.json](scope.json)。

## 剩余事项

DONE：公开视频封面、公开字幕、来源/图片不退步、3080 页面与文件证据、测试及文档。当前服务运行于 [3080 工作台](http://127.0.0.1:3080/)，保持第一期人工审核模式。两篇 partial 仍提示视频动态画面/Instagram 内容未提取及资源等待诊断；本次没有把这些未获取内容判为完整。NEXT（可选）：人工审核新增字幕及配图理解范围；无需接入真实生图即可验证本轮修复。
