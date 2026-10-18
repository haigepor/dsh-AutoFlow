# 文章抓取性能与 GitHub 工具评估

日期：2026-10-18，Asia/Shanghai。对象：现有 article-image-toolkit 及 3080 文章工作台。Observed 表示已读代码/官方源码或本轮测量，Inferred 表示由这些证据推导的建议，Assumed 表示尚待实验的目标。本轮仅研究和隔离实验，没有修改产品源码、依赖、配置或真实业务任务，没有模型分析或生图调用。

## 结论与实际行动

**Inferred：最有价值的顺序是“可验证的静态快路 → 浏览器子资源减负及受控连接复用 → 大图下载优化”，然后按实测结果选择外部模块。** 保留现有富文本抽取、原图字节、失败分类与公网安全策略。暂不将 Crawlee、Scrapling 等整套框架设为主导。

**Observed：本轮已执行 16 组真实网络生产内核实验。** Correio 三次对照中，复用现有抽取及真实图片解码的静态路径中位数从 19.728 秒降至 6.234 秒（约 68.4%），块内容、列表结构和原图 SHA256 一致。另一个 gov.br 样本虽然原块/原图都保留，却增加一个分类文字块，因此未批准静态默认启用。R7 静态路径只用 3.492 秒但丢失字幕与封面，明确否决；延后浏览器视觉资源的单样本从 41.353 秒变为 34.170 秒，143 块、131 条字幕与封面一致，只批准继续试验。

这些是**隔离内核 POC，不是 3080 已上线提速**。当前 3080 保持原有版本与配置；本轮没有将快速但丢内容的结果写回工作台。

## 一、真正调用的是哪条链路

Observed：工作台 `src/host/workflow-service.js:29,211` 创建 `createCapture` 并调用 `capture.capture`；工具包 `src/capture.js:345` 无条件先调用 renderer。旧 `src/service.js:165` 的文本阶梯与 `src/fetch.js:50` 的 HTTP/缓存链路是另一条入口。仅换旧 static provider，不会自动加速当前富文本工作台。

```mermaid
flowchart LR
  U[URL 与公网校验] --> B[当前: 每篇浏览器导航/脚本/样式/图片/广告]
  B --> W[正文就绪/滚动/全页 networkidle]
  W --> D[JSDOM/容器收窄/公开子页与字幕]
  D --> I[串行原图下载/候选回退/真实解码]
  I --> P[校验与原子发布/人工审核]
```

Observed：`src/capture-renderer.js:112` 的唯一 context route 将页面资源交给受控 Node 请求；`:132` 每个资源调用普通 request，普通传输在 `src/capture-media.js:183` 使用一次性连接，而原图 session 在 `:128,141,164` 已有篇级 keep-alive。`:203–234` 保留正文条件、滚动、pendingSelector 与 networkidle 稳定窗口；`:305` 后的图片解码器已经篇内复用，不能再把“每图新建 context”作为当前事实。`src/capture-media.js:279` 的原图循环仍为串行。

Observed：本地 `network.js:10` 已有受 TTL 和条目上限限制的 DoH 缓存；它不是完全没缓存。代码未提供同一冷 hostname 的在飞查询合并。Inferred：并发冷请求可能重复 DoH，但本轮没有直接量出其占比，不能把所有网络延迟归因于 DNS。

## 二、既有 28 篇回归的成本分布

Observed：来源为当日 15:50 的完整 3080 回归报告，整批 874.446 秒、并发 2、21 篇正文快照；它早于最近 R7 字幕和 Metrópoles 封面修复，不是本轮重新跑 28 篇，也不是当前版本的冷启动基准。

| 阶段 | 28 篇累计执行工作量 | 占累计运行时间 |
|---|---:|---:|
| 浏览器渲染/页面等待 | 1212.950 秒 | 70.36% |
| 正文抽取及子内容合并 | 26.126 秒 | 1.52% |
| 图片阶段 | 436.451 秒 | 25.32% |
| 其中图片下载 | 358.472 秒 | 20.79% |
| 其中真实解码 | 77.831 秒 | 4.51% |

下载和解码包含于图片阶段，不能再相加；累计工作量不是整批墙钟时间，浏览器请求还会并行。两篇图库贡献明显：Guia #10 原图约 90.3MB，下载 99.0 秒、解码 34.4 秒；CNN #19 下载 125.2 秒、解码 13.1 秒。不能用几百 KB 的网页 HTTP benchmark 代表这类任务。

Inferred：单独把正文 parser 加速一倍，只减少约 0.76% 的这份累计运行工作量；即使假设图片解码完全免费，其工作量上限也仅约 4.5%。因此 parser/图片库升级都不应排在页面链路优化之前。这里没有把工作量占比直接换算为用户总等待的提速保证。

## 三、本轮 16 组隔离对照

Observed：Node `v25.2.1`，Windows。直接使用当前 `createCapture`、`createPublicRequest`、现有 CookieJar、代理/DoH、公网地址固定、现有富文本抽取、候选/预算及 Chromium 图片真实解码。每个样本创建并关闭独立 capture/浏览器实例，模式交错执行；系统及代理缓存未清，不能称为完全冷网络。一次只运行一个样本，未关闭用户其他程序。

计时从 capture 调用开始，到返回完整快照及就绪图片为止，含必要的浏览器启动；dispose 单独计时并等待完成。没有 UI、业务落盘或真实模型开销，不能当作 3080 端到端数字。静态 POC 只替换 render 依赖为同一受控 HTTP 的不执行脚本的 HTML，其余使用真实实现；defer-media 仅在私有 launcher 依赖中 abort 浏览器 image/font/media 请求，原图仍在正常图片阶段获取，没有加入生产参数。

| 文章序号 | 模式 | 原始样本（秒） | 中位数（秒） | 内容对照 |
|---:|---|---|---:|---|
| 5 | browser | 19.728, 26.852, 12.566 | 19.728 | 一致 |
| 5 | static | 4.957, 6.234, 9.852 | 6.234 | 一致 |
| 18 | browser | 32.021, 32.006, 29.672 | 32.006 | 一致 |
| 18 | static | 16.581, 7.931, 7.692 | 7.931 | 拒绝默认启用 |
| 21 | browser | 41.353 | 41.353 | 一致 |
| 21 | static | 3.492 | 3.492 | 拒绝默认启用 |
| 21 | defer-media | 34.170 | 34.170 | 一致 |
| 24 | static | 4.043 | 4.043 | 拒绝默认启用 |

- Observed，Correio #5：两模式 5/5 块及含 7 个目的地的列表结构一致，原图哈希一致；受监测传输调用每篇从 52 次变为 2 次。只证明这个样本可行，站点尚须静态完整性规则，不能仅凭字数达标默认通行。
- Observed，gov.br #18：原有 7 块顺序及原图均保留，静态变为 8 块，多出分类词“Notícias”。三次均如此。静态伪 renderer 还让既有 quality 检查显示 passed，这是本实验的已知限制：该标签不是静态模式完整性证据，绝不写回业务。正式静态模式必须使用准确来源检查标签和站点噪声规则。
- Observed，R7 #21：浏览器 143 块、131 条字幕、1 张封面；普通静态仅 11 块、原块顺序保留 8/143、0 图、0 字幕。它虽然返回快照对象，仍判定为内容验收 FAIL，必须回退浏览器或另做经过验证的当前文章元数据 provider。
- Observed，R7 defer-media：本次 143/143 块、131 字幕、封面哈希完全相同；监测传输调用 124→90，单次耗时减少约 17.4%。主文档响应本身还从约 7.2 秒波动到 13.4 秒，说明网络样本不可当作稳定性能保证。没有据此全局禁用所有图片或媒体。
- Observed，BCB #24：普通静态返回 `article-extraction`，与其现有可读取正文不等价。它是 SPA 回退必要性的阴性对照，不是允许丢弃的失败项。

传输调用数不是实际 TCP 握手数或线上 HTTP 请求数，底层重试、跳转、DoH 会另有请求。资源 bytes 是收到并解压后的响应体字节，非线上压缩流量；单个请求耗时重叠，不能相加为页面耗时。详见 [results.json](results.json)、[aggregates.json](aggregates.json)。

## 四、GitHub 候选工具判定

Observed：通过 GitHub MCP 检索、官方固定源码及官方文档核验。版本栏区分源码 package 版本与 release，不把 main 分支版本直接等同 npm 稳定版；没有安装这些候选依赖或引用星数作为性能依据。

| 项目 | 核验事实 | 判定与用途 |
|---|---|---|
| [Undici](https://github.com/nodejs/undici) | 固定源码 package 8.12.2，MIT，Node ≥22.19；Pool、自定义 lookup/connector、流式 body、close/destroy | **Inferred：可选传输 POC。** 适合 renderer 同域连接复用及后续 HTTP/2；先比较扩展现有 Agent，不能承诺换库即提速。 |
| [Ghostery adblocker](https://github.com/ghostery/adblocker) | Playwright wrapper 2.20.1，MPL-2.0；有纯规则匹配核心 | **Inferred：仅核心匹配 POC。** 在现有受控路由内决定阻止明确广告/跟踪请求，不接默认 DOM 修改及自动订阅。 |
| [sharp](https://github.com/lovell/sharp) | 官方 Apache-2.0；Node-API、Windows 预编译及 libvips | **Inferred：次优先级解码 POC。** 大图可能受益；只读 metadata 不是真实解码，需验证完整像素读取、损坏图片、EXIF、预算、内存与取消，保留原图原始字节。 |
| [Scrapling](https://github.com/D4Vinci/Scrapling) | 官方已发 v0.5；BSD-3-Clause，Python ≥3.10；MCP 仍以 content 字符串返回 | **Inferred：仅保留可选 TLS provider 方向。** 不替换富文本抽取和浏览器，不默认嵌套第二个 MCP 进程。 |
| [impit](https://github.com/apify/impit) | release js-0.14.6；Apache-2.0，Rust/N-API、Node ≥20，Windows 二进制 | **Inferred：目前不接默认传输。** 检查的 Node options/Rust builder 未暴露目标公网 IP pin；localAddress 只绑定本地网卡。补齐并验证安全传输后再 POC。 |
| [Crawlee](https://github.com/apify/crawlee) | 固定源码 Playwright package 4.0.0，Apache-2.0；自有 browser/session/pool/retry 生命周期 | **Inferred：本轮不整套引入。** 与现有任务、Cookie、重试、预算和 dispose 重叠，先借鉴调度，不能据框架替换推导单篇更快。 |
| [got-scraping](https://github.com/apify/got-scraping) | 固定源码 4.2.2；官方明确 EOL、不再更新/支持，推荐 impit | **Observed/Inferred：不新增。** 不把过时教程当作新项目依赖依据。 |
| [htmlparser2](https://github.com/fb55/htmlparser2) | 固定源码 12.0.0，MIT，Node ≥20.19；事件/流式 parser，官方说明存在速度与 HTML 规范取舍 | **Inferred：低优先级局部 POC。** 可研究少量 metadata，不整体替换 JSDOM/Readability；当前抽取仅约 1.5% 工作量。 |

### 必须守住的接入细节

**Undici。** Observed：[自定义 lookup 与 connector](https://github.com/nodejs/undici/blob/e8f34234d10febe285ebc29c971c44c79220a123/docs/docs/api/Client.md#L199-L215)和 [close/destroy](https://github.com/nodejs/undici/blob/e8f34234d10febe285ebc29c971c44c79220a123/docs/docs/api/Client.md#L235-L252)有官方 API。Inferred：按 origin、已验证 IP 集合、proxy 和匿名会话分池；代理 CONNECT 固定目标 IP，TLS SNI/Host 仍为发布站；显式设置 body 大小和超时，不使用默认无限 body。HTTP/2 需单独验证；任意新闻站不默认启用 HTTP/1.1 pipelining>1。支持 lookup 不等于我们的代理链路已经安全集成。

**Ghostery。** Observed：[wrapper 注册 page.route](https://github.com/ghostery/adblocker/blob/c18718adc33e82a086d996d0b0f75deb3d01745a/packages/adblocker-playwright/src/index.ts#L65-L84)，允许资源走 [route.continue](https://github.com/ghostery/adblocker/blob/c18718adc33e82a086d996d0b0f75deb3d01745a/packages/adblocker-playwright/src/index.ts#L272-L310)；[Playwright 官方](https://playwright.dev/docs/api/class-page#page-route)明确 page route 优先于 context route，routing 还会关闭 HTTP cache。Inferred：直接调用 enableBlockingInPage 有绕过当前 context pinned transport 的风险，禁止照抄接入。只把 engine.match 嵌进既有唯一 route，未命中仍走 request/fulfill；不调用 continue，不注入 scriptlets/cosmetics，不移除播放器/正文 iframe。引擎 MPL 与过滤规则、注入资源的许可分别核查；默认远程列表不自动下载。

**sharp。** Observed：[metadata() 官方说明](https://sharp.pixelplumbing.com/api-input/#metadata)只读头，不解压像素；[stats()](https://sharp.pixelplumbing.com/api-input/#stats)读取像素统计；[安装说明](https://sharp.pixelplumbing.com/install/)列出平台二进制。Inferred：只允许等价完整解码 provider 试验，不以 metadata 读取替代现有坏图校验，不缩图、不重新编码原图。若缺少受控取消或内存隔离，就保留 Chromium 解码；原生包及附带编码器另审分发成本。

**Scrapling。** Observed：[v0.5 release](https://github.com/D4Vinci/Scrapling/releases/tag/v0.5)晚于本地旧评审，不能把 v0.4.15 测量当作新版数据；[新版 ResponseModel](https://github.com/D4Vinci/Scrapling/blob/3a8bf4e4d3ed91257ba0aa5b7dc66241d1e23840/scrapling/core/ai/server.py#L113-L118)仍不直接返回 raw bytes/headers，[make_request](https://github.com/D4Vinci/Scrapling/blob/3a8bf4e4d3ed91257ba0aa5b7dc66241d1e23840/scrapling/core/ai/server.py#L639-L714)按单次 session 工作。旧报告的首条 HTTP 中位数 Node 2272ms→Scrapling 1176ms，不能外推当前富文本 40–65 秒会减半；旧默认替换还出现26→24成功数回退，见 [旧评审](../scrapling-feasibility-2026-10-17/report.md)。继续保持不安装浏览器/Python运行时、不解验证码及不越过登录/付费墙的约束。

**impit / Crawlee / got-scraping / htmlparser2。** Observed：[impit 完整 Node options](https://github.com/apify/impit/blob/a72b2a06382d9adcfd1d3c5c689073fcf09a42da/impit-node/index.d.ts#L296-L380)及 [Rust local_address](https://github.com/apify/impit/blob/a72b2a06382d9adcfd1d3c5c689073fcf09a42da/impit-node/src/impit_builder.rs#L155-L190)未提供本次所需的目标 DNS pin 开关；[Crawlee session/teardown](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/packages/browser-crawler/src/internals/browser-crawler.ts#L728-L792)已有独立所有者；[got-scraping EOL](https://github.com/apify/got-scraping/blob/031f04c9b8b1e8c4a18b70c890c31ba913ea59c4/README.md#L1-L6)是正式声明；[htmlparser2](https://github.com/fb55/htmlparser2/blob/a4c60b8e0019e191df39acaee02bc5d5d8213c44/README.md#L10-L31)不提供浏览器 DOM/CSS 完整替代。上述判断是当前已查接口的限制，不宣称这些项目永久不能满足需求。

## 五、建议的实施切片

以下为 Inferred 方案，均尚未修改生产代码；每个切片可独立关闭和回滚，不同时改多个因素来制造难以归因的提速。

1. **P0：按站点验证的静态快路。** URL 仍先过 captureUrl+公网策略；只取一次原始 HTML，先执行访问限制检查。经已配置 root/end/列表/原图和必要 metadata 规则证实完整，才复用现有富文本抽取与图片阶段；不确定、SPA、动态 Story、R7 当前字幕规则需回退浏览器。重用已经取回的主文档时仍验证 URL/公网/响应身份与 Cookie 语义，避免先 static 再 browser 重复完整下载。Correio 是最先补验收的样本；gov.br 先去掉分类噪声。正式结果检查应区分 static-dom 与 rendered-dom，不能沿用 POC 的伪 renderer 标签。
2. **P0：浏览器子资源连接复用。** 在目前唯一受控 HTTP 路径增加篇级资源 session，复用现有 Agent 或比较 Undici connector；公网 IP 集合变动即隔离旧池，保持代理和 Cookie 作用域。当前原图已复用，优先补页面 scripts/styles/fonts 等请求，不能重复宣称原图从零开始做 keep-alive。
3. **P1：受控资源策略与就绪条件。** 小型本地规则先于 Ghostery SDK；明确阻止广告/跟踪资源，正文 XHR、Story、字幕、播放器元数据与原图 CDN 优先保护。先分别试字体、视频流及已在独立资产阶段获取的图像，不全局禁 script/style/image。只在站点 end/pending/字幕声明就绪规则通过后缩短等待，不靠 networkidle=0 或截短滚动来假装加速。
4. **P1：同次抓取内的响应复用。** 浏览器已有图片字节只有在最终 URL、请求 Accept/Cookie/Referer/UA 及 Vary 条件等价时才复用；当前浏览器和原图头并不完全一致，同 URL 不足为依据。缩略图不得冒充原图，no-store/敏感响应不跨任务保存。缓存有篇级总字节上限和清理所有者；回放目标仍重新过公网策略，完整解码与哈希照做。
5. **P1：原图受限并发。** 从可配置并发2试起，按输入顺序提交图块，提前预留整篇字节额度、保留未知用量保守扣除和原候选重试。现有每 origin Agent maxSockets=1，直接 Promise.all 或只提高 poolSize 不能保证并行。下载、解码队列和每 host 上限分开；任何失败不能使 98 张既有图回退到更小候选。
6. **P2：DoH 在飞合并与可选解码器。** 先量出冷 hostname 重复查询及解码 CPU，再考虑共享查询；每个等待者独立取消，全部离开或 dispose 才取消底层请求，不延长 DNS TTL 或跳过公网校验。sharp 使用本地现有原图做 Chromium 等价完整解码、损坏输入和 RSS 比较，若收益不足则取消新增依赖。
7. **P2：再调文章并发。** 先降单篇请求量，再将篇级并发2逐级试3/4；不直接拉到8。CPU、内存、代理连接、429与尾延迟都作为退出条件。并发不能减少单篇工作量，只可能改变排队和资源争用。

## 六、上线前的 Go / No-Go

- Observed 基线：当前业务有 28 条、21 份正文快照、98 张 ready 图片；R7 131 条字幕。后续验收以这个新基线为准，不能继续只检查旧97张。
- **Go 内容条件**：28 篇全部复测，正文顺序/嵌套列表/图注及图片说明无丢失，98张原图哈希保留，R7 131条时间和文字逐项一致，原6条restricted和1条short不通过缩短内容伪成功。动态页面和不确定静态页面正确回退，不能把新增分类/导航噪声算作改善。
- **Go 安全条件**：重定向跳私网/DNS rebinding/代理 CONNECT固定IP、Cookie隔离、缓存Vary/no-store、限流/大小预算、取消和dispose、进度与原子发布均有 owning 回归；不引入 AGPL 或非商用依赖。HTTP/2、DNS cache 和过滤引擎都不豁免这套检查。
- **Assumed 性能目标**：同配置、同语料，当前版本与候选版本各做交错的至少3轮3080批量，分开冷/暖，比较整批墙钟、单篇P50/P95、API尾延迟、失败数、传输字节与峰值内存。可先把“整批中位耗时降低20%，P95不恶化超过10%”设为设计目标；这是待验证目标，不是本轮兑现数字。
- **No-Go**：任何正文/列表/原图/字幕回退；仅靠较小图、少抓图片、跳过真实解码、隐藏受限页、忽略写入/清理或扩大预算取得提速；孤立 HTTP/本地1KiB基准很快但工作台总体无收益；依赖不能保持目标IP固定或显著增加维护成本。

建议后续实施归入一个独立 OpenSpec 性能变更，先确认指标与切片再创建；本轮只交付可审查研究与 POC，不创建 OpenSpec 或自动切换生产路径。

## 七、证据、范围和局限

DONE：当前入口与成本剖析、8个 GitHub 候选核验、16组真实网络实验、静态/SPA/字幕反例、建议顺序及验收门槛。NEXT：按上述P0切片实施并经3080全量验证。未承诺本轮完成依赖集成或产品提速上线，候选库的实际性能尚未测量。

本轮只新增本报告目录，完整源码/依赖/配置的任务前字节基线在私有实验目录；不修改 AGENTS、Skills、Memories 或 Codex配置。真实业务索引与产品 profile 前后比较不变；3080仍在运行，未携鉴权的请求返回401符合预期。完整抓取样本及实验脚本保存在 `C:/Users/haige/AppData/Local/Temp/article-speed-study-xvfytbtk`，原始文章和配置留在私有文件，默认报告仅含站点、计数、耗时与受控诊断，不公开 Cookie/凭据/全文。回滚只需移除本轮新增报告文件，不涉及用户原有改动。

本轮没有修改产品逻辑，因此未重复运行已通过的412项工具包/157项插件测试；这些数字属于上轮修复，不能算本轮新增性能代码验收。本轮验收是实验退出、内容差异分类、报告JSON/UTF-8、范围及业务/profile不变检查，详见 [scope.json](scope.json)。
