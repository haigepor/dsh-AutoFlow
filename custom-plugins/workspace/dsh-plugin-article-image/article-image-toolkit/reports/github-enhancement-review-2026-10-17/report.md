# article-image-toolkit 完善方案与 GitHub 候选评审

日期：2026-10-17。范围：现有 MCP 工具包、工作台共用富文本捕获内核、可选请求 provider、正文与原图质量、MCP 进度和诊断。复杂度 L；本轮完成 Research 与建议设计，没有实施产品修改。本轮只增加此报告目录，在 Temp 安装实验依赖；保留原有未提交改动，不改 OpenSpec、依赖清单、配置、Skills 或现有测试。

标记：Observed＝本轮代码或实验直接证据；Inferred＝由证据推导的设计建议；Assumed＝尚需验证的收益、工作量或条件。版本和结果只对应下列固定源码及实验环境。上轮 Scrapling 基线与本轮实验区分记录，不把不同时间、不同操作的数值拼成性能结论。

## 1. 结论与优先级

**Inferred：继续以当前 Node MCP 和公共捕获内核为主体。优先修复共享传输、生命周期、诊断、图片候选与完整性证据；引入少量可替换组件。** 可选 TLS 请求候选为 impers、Impit 和已有 Scrapling/curl_cffi；Defuddle 只进入离线影子抽取；srcset 标准解析器可以进入小范围实现验证；Crawlee/Crawl4AI 不整体嵌入。

**Observed：更换爬虫品牌并不能直接修好工作台。** 旧文本阶梯和工作台富文本是两条调用路径；而富文本浏览器的 HTTP 请求由 Node 代发。若把新 HTTP provider 只接到旧 readArticle，工作台仍使用旧传输。若只换浏览器内核却保留 Node 路由代发，TLS 握手能力也没有随浏览器改变。

**Inferred：本轮建议实施顺序是 P0 可诊断与可停止 → P1 共享请求适配 → P2 原图保真 → P3 抽取质量试点 → P4 MCP 资源与长任务。** 其中 P0/P2 的主要价值来自现有源码缺口，不依赖任何外部爬虫。是否生产启用 TLS provider，必须以固定地址、证书校验、逐跳策略及真实文章回归为条件。

## 2. 当前调用链与真正的修改位置

```text
旧文本 MCP
  article_image_fetch → ArticleService.readArticle
    → fetchArticlePage → createPublicRequest → requestPinned(Node HTTP)
    → 同字节 structured → Renderer 双投影 → extractArticle

富文本 MCP / 插件工作台
  article_image_capture_source → CaptureSourceService → createCapture
  工作台 WorkflowService ────────────────────────────┘
    → CaptureRenderer → context.route → createPublicRequest(Node HTTP)
    → 原始 DOM 中确定正文范围 → 有序 blocks / figure occurrences
    → captureAssets → createPublicRequest → 原图校验与不可变快照

录制与回放
  Recorder / CaptureRenderer / replayExchange
    → 同一公网校验原则；凭据和写请求权限仍需单独管理
```

**Observed，两个入口**：[service.js:60](../../src/service.js) 委托 richCapture，[service.js:129](../../src/service.js) 是旧文本阶梯；[workflow-service.js:197](../../../src/host/workflow-service.js) 调用 createCapture 并接收 progress。它们可以共用纯捕获实现，但不是同一个记录存储格式；不能未经迁移把旧 state.json 和 rich snapshot 混写。

**Observed，TLS 请求发生位置**：[capture-renderer.js:93–111](../../src/capture-renderer.js) 拦截请求并调用 this.request，之后 route.fulfill。浏览器执行 JS，HTTP 取字节使用 [capture-media.js:67、103](../../src/capture-media.js) 的公网校验和 Node 连接。因而 patchright 名称本身不能证明该路径采用 Chromium ClientHello。

**Inferred，建议保留的职责**：URL/DNS/逐跳策略、CookieJar、pacer、cache、decode、失败族、正文质量、快照和取消都由现有 Node owner 负责。新增 transport 只接收已解析的请求参数，返回有界 bytes、headers、status 和实际连接证据。实现应位于 createPublicRequest 下的连接提供者，而不是把整个网络 owner 替换成另一个爬虫。

## 3. GitHub 搜索与候选判定

**Observed，方法**：通过用户选定的 GitHub 插件执行 repository 搜索、tree、许可证、package 与源码读取；没有以 stars 或“活跃”作为采纳依据。搜索主题包括 defuddle、got-scraping、impers、Impit、正文抽取、MCP 网页工具和 srcset。搜索发现的封装项目还需许可和源码筛选，不能因名称带 MCP 就视为生产候选。

| 候选 | 证据与许可 | 对本工具包的建议 |
|---|---|---|
| [Mozilla Readability](https://github.com/mozilla/readability/blob/ab4027a8b37669745016869a37a504727992b2ba/Readability.js) | Observed：当前已使用 0.6.0；上游 Apache-2.0/NOTICE；DOM 正文抽取。 | Inferred：保留主抽取；继续站点范围、首尾噪声、列表表格和图片 occurrence 验收。 |
| [Defuddle](https://github.com/kepano/defuddle/blob/556d74e8c8fd68c49912d4b11a4ae9ec04d7b2b5/src/types.ts) | Observed：MIT；0.19.5；Document 输入、HTML 输出、图片保留、profile；useAsync 默认允许额外网络。 | Inferred：仅影子抽取，禁网络、禁 debug 结果替代生产；本轮有改善也有正文丢失。 |
| [impers](https://github.com/lexiforest/impers/blob/b7bbb24ac29c6599db701bd614499dcbaa183b4b/src/http/session.ts) | Observed：MIT；0.1.2；Node/Koffi/libcurl，原始 headers、Buffer/callback、AbortSignal、curlOptions。 | Inferred：值得做低层请求 PoC；先验证 RESOLVE 的 slist 生命周期、无隐式代理、解压预算和原生回收。 |
| [Impit](https://github.com/apify/impit/blob/71111b91f3dc8901607e3dcf7456c4c0d0ec54c2/impit-node/index.d.ts) | Observed：Apache-2.0；0.14.6；Rust/N-API，Windows 包，fetch/stream/headers/signal。 | Inferred：Node 内 TLS 候选；公开 Node 参数没有目的地址固定入口，当前不能满足生产替换条件。 |
| [Scrapling](../scrapling-feasibility-2026-10-17/report.md) | 上轮 Observed：部分 403 改善；原 MCP 缺 bytes/headers、错误类型和 IP pin。 | Inferred：保留可选窄 Python bridge 候选，不嵌套原版 MCP 作为默认请求层。 |
| [got-scraping](https://github.com/apify/got-scraping/blob/031f04c9b8b1e8c4a18b70c890c31ba913ea59c4/src/index.ts#L43-L97) | Observed：调整 Node TLS；默认 rejectUnauthorized:false、宽松 parser，存在 Got 原型副作用；该 tree 根目录未找到许可证正文。 | Inferred：不作为默认候选；如比较须恢复严格 TLS/parser，查指定发布包许可及 HTTP/2 的 DNS 路径。 |
| [Crawlee](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/packages/basic-crawler/src/internals/basic-crawler.ts#L1192-L1249) | Observed：Apache-2.0；自带队列、SessionPool、CookieJar、AutoscaledPool 和客户端。 | Inferred：借鉴 HttpClient、owner/注入和资源感知调度，不引入第二套运行时。 |
| [Trafilatura](https://github.com/adbar/trafilatura/blob/e2f85c965662c7df26b73290ef175b2c2a5fdca6/trafilatura/core.py#L482-L551) | Observed：当前 Apache-2.0；可直接输入已有 HTML，保结构/表格/部分图片；旧许可历史和 Python 成本要明确。 | Inferred：有额外抽取需求时离线比较；不能替代当前 srcset、原图 bytes 和位置归档。 |
| [Crawl4AI](https://github.com/unclecode/crawl4ai/blob/94b67888ca8b335ff2121423a50e06dd27661922/LICENSE#L51-L67) | Observed：Apache 文本另有 Attribution Requirement；完整 Python 爬取框架。 | Inferred：不整体集成；参考图片变体分组与诊断字段，额外署名要求不能忽略。 |
| [parse-srcset](https://github.com/albell/parse-srcset/blob/03104fe7a2cdfd898e3717fef402fce528740370/src/parse-srcset.js#L89-L120) | Observed：MIT；标准算法保留 URL 内逗号；本轮离线样例正确。 | Inferred：作为替换手写逗号切分的候选；先验语法/descriptor/不发网络，再评估打包和维护成本。 |
| [@extractus/article-extractor](https://github.com/extractus/article-extractor/blob/08159d55041909759f3718d05afe4ea0597f9b11/src/utils/extractWithReadability.ts) | Observed：MIT；内部仍使用 Readability+linkedom，支持已有 HTML。 | Inferred：补充元数据处理参考；当前没有证据表明再包一层能提升已修复正文质量。 |
| [DOMPurify](https://github.com/cure53/DOMPurify/blob/cde95990b2190338cfd7c00b768f3d81d3219d61/LICENSE) | Observed：可选择 Apache-2.0 许可文本；是 HTML 安全过滤器，不是正文抽取器。 | Inferred：只有需要原 HTML 展示/导出时再评估；现有 typed blocks 不因增加库而更完整。 |

**Observed，MCP 封装筛选**：搜索返回 JoaoPedroLanca/mcp-web-tools、Bariskau/weblens-mcp 等；本轮 GitHub metadata 没有返回它们的许可证标识，不能视为获准复用。未复制或执行它们的实现。优先沿用当前官方 SDK，把协议能力接到自己的 service。

**Observed，源码细节**：got-scraping、Crawlee、Trafilatura、Crawl4AI 和 Readability 的固定行号、下游条件与许可缺口见 [候选源码评审](candidate-source-audit.md)。候选根许可证检查不等于完整传递依赖或二进制分发法律审查；正式引入前仍需锁定 tarball、NOTICE 和依赖清单。禁止 AGPL、ai-crawler-helper、验证码 solver、自动安装 Python/浏览器等原约束继续适用。

## 4. Defuddle 的同 HTML 离线实验

**Observed，口径**：使用上轮保存的 Node static HTML，未重新请求网站；28 条中 #7 无保存 HTML、#11 保存的是 403 非 HTML，跳过 2 条，实际处理 26 条，其中包括 3 个 BCB SPA 壳。使用 defuddle@0.19.5、当前 jsdom/Readability，useAsync:false、fetch 拒绝、debug:false、markdown:false、removeImages:false、includeReplies:false；零额外网络尝试。不执行页面脚本，不下载图片。

**Observed，度量限制**：下表是同一 HTML 的裸 Readability 与 Defuddle 结果内 p/img 数量，不是原 MCP paragraph 数、不等于有效文章图片数；列表/表格/裸文本可能不在 p 中。字符数和首段、five-gram 对比保存在 [defuddle-summary.json](defuddle-summary.json)。完整原始抽取文本仅留在 Temp，未随报告复制。BCB 三个静态壳不能代表其渲染后文章；不要拿该实验覆盖原26成功+2短文验收。

| # | Readability p | Defuddle p | Readability img | Defuddle img | 解释 |
|---|---:|---:|---:|---:|---|
| 1 | 58 | 63 | 0 | 8 | Defuddle首段为作者，增加图片候选但未下载验证 |
| 2 | 22 | 31 | 0 | 5 | 作者/元数据仍需现有清理 |
| 3 | 9 | 19 | 0 | 3 | 作者/元数据仍需现有清理 |
| 4 | 22 | 21 | 1 | 2 | 首段仍为更新时间 |
| 5 | 2 | 2 | 0 | 0 | 段数不等于现有规范化paragraph |
| 6 | 13 | 13 | 0 | 0 | 两者接近 |
| 7 | — | — | — | — | 无保存HTML，未测 |
| 8 | 21 | 20 | 1 | 1 | 首段仍为日期 |
| 9 | 7 | 12 | 0 | 2 | 首段仍为作者 |
| 10 | 15 | 15 | 1 | 1 | 首段仍为日期 |
| 11 | — | — | — | — | static403非HTML，未测 |
| 12 | 20 | 0 | 0 | 1 | Gov Saúde：1698字符正文变0，明确退步 |
| 13 | 30 | 34 | 0 | 2 | 作者元数据仍存在 |
| 14 | 24 | 30 | 0 | 1 | 作者元数据仍存在 |
| 15 | 49 | 34 | 1 | 2 | byline仍为首段 |
| 16 | 13 | 14 | 1 | 1 | 首段仍为栏目字段 |
| 17 | 12 | 14 | 1 | 2 | byline仍为首段 |
| 18 | 25 | 2 | 0 | 0 | 文本保留率约97.9%，段数下降不能直接判丢文 |
| 19 | 18 | 14 | 0 | 1 | 有文章首段 |
| 20 | 15 | 14 | 2 | 1 | 图片候选减少，需要人工归类 |
| 21 | 36 | 5 | 17 | 0 | R7：大量推荐文章被去除，正文更聚焦 |
| 22 | 54 | 44 | 3 | 4 | 尚需范围与图片核对 |
| 23 | null | 0 | null | 0 | BCB静态壳；不是渲染正文 |
| 24 | null | 0 | null | 0 | BCB静态壳；原完整阶梯有效文章不能因此改为空 |
| 25 | null | 0 | null | 0 | BCB静态壳 |
| 26 | 7 | 8 | 1 | 1 | 首段出现描述性文本，需和原图caption区分 |
| 27 | 10 | 11 | 0 | 0 | 首段为栏目标题 |
| 28 | 7 | 5 | 2 | 0 | 去除了日期；图片是否正文需另验 |

**Observed，R7 的具体判断**：原结果约5002字符，包含连续的推荐文章标题和简介；候选约1516字符保留主文5个p及尾部平台推广。five-gram 覆盖约30.7%，这次下降很大一部分是去噪，不能直接宣称漏掉69.3%正文。Gov Saúde 则由1698字符直接变0，是真正的失败。两个反例共同说明，不能按字数最多或某个统一相似度阈值自动选赢家。

**Observed，运行开销**：单次顺序离线采样的 Defuddle中位数633.4ms，裸Readability47.3ms；不含最初JSDOM输入解析，Defuddle包含候选输出DOM统计、profile及其额外处理，未做热身和五轮，因此不能据此宣称准确性能倍率。它不是已证实的提速替换。仅6/26的首p完全相同，也不等于另外20条都错误。

**Observed，不能直接用于生产 debug**：[README:305–329](https://github.com/kepano/defuddle/blob/556d74e8c8fd68c49912d4b11a4ae9ec04d7b2b5/README.md#L305-L329) 说明 debug 会保留class/id/data属性并跳过部分结构扁平化；它会改变结果，不只是增加日志。[types.ts:87–92、150–156](https://github.com/kepano/defuddle/blob/556d74e8c8fd68c49912d4b11a4ae9ec04d7b2b5/src/types.ts#L87-L92) 声明额外网络及自定义fetch。生产影子输入也必须先经过现有限制页判断，禁第三方API取全文，失败结果不得降格成有效文章。

**Inferred**：试点只记录候选差异，保留现有结果；在明确站点/失败原因下启用候选。两个候选严重不一致时返回 needs-review，图片与正文范围依据来自原DOM、站点adapter和可核对的首尾/结构证据，而不是把两个输出拼成更长文章。

## 5. Node TLS 候选的本机运行与限制

**Observed**：在Temp用npm --ignore-scripts安装 impit@0.14.6 和其Windows原生可选包，Node v25.2.1、Windows x64；没有安装Python运行时或浏览器。显式校验证书、禁自动redirect、15s预算、8MiB读取上限；每个初始URL先过captureUrl+公网策略。但Node公开参数无法固定目的IP，此实验不构成安全验收。结果见 [impit-probe.json](impit-probe.json)。

| URL | HTTP | 耗时ms | 结果说明 |
|---|---:|---:|---|
| fixture首条Folha文章 | 200 | 4768.6 | 可返回HTML、headers、流；338250 bytes |
| AP News首页 | 403 | 1429.7 | 返回验证页标题，未尝试解决 |
| CNN首页 | 200 | 2025.5 | 正常网站标题，5804146 bytes |
| USA Today首页 | 200 | 2720.9 | 正常网站标题，240944 bytes |

**Observed**：预先取消的AbortSignal返回AbortError，5.9ms；仅验证预取消，不代表所有在飞取消/进程退出竞争已验证。headers.getSetCookie存在。一次采样不能和上轮Scrapling跨时间排名：上轮AP200/USA403，本轮Impit相反，恰好说明没有通用“能过所有站”的provider。

**Observed，Impit缺口**：[Node options:295–385](https://github.com/apify/impit/blob/71111b91f3dc8901607e3dcf7456c4c0d0ec54c2/impit-node/index.d.ts#L295-L385) 没有目的DNS/IP覆盖；localAddress是本地绑定地址，不是远端固定地址。[Rust client构建:275–313](https://github.com/apify/impit/blob/71111b91f3dc8901607e3dcf7456c4c0d0ec54c2/impit/src/impit.rs#L275-L313) 使用reqwest，审阅分支未见Node传入已验证目的地址的能力。代理环境行为和解压后预算也需要负向试验，不能把“未传proxyUrl”当作已认证没有隐式代理。

**Observed，impers更低层但未实测**：[session.ts:196–270](https://github.com/lexiforest/impers/blob/b7bbb24ac29c6599db701bd614499dcbaa183b4b/src/http/session.ts#L196-L270) 有原始curlOptions、读取callback和signal；这为RESOLVE/PROXY/禁复用提供了可能入口，但不是已完成的适配器。[loader.ts:338、735–789](https://github.com/lexiforest/impers/blob/b7bbb24ac29c6599db701bd614499dcbaa183b4b/src/ffi/loader.ts#L735-L789) 会探测并尝试下载curl库，只有设置IMPER_DOWNLOAD_LIBCURL=0、部署明确提供并校验原生库等条件才符合显式依赖策略。本轮未安装/加载impers，不声称可在本机成功。

**Inferred，选择纪律**：先验证哪个候选能严格执行固定地址和资源预算，再比较拒绝改善率、全文质量和成本。impers保留低层控制的研究优先级，Impit等待上游/适配层增加pin能力，Scrapling窄bridge作为Python可选实现；当前没有任一候选完成全部生产验收。原生进程内实现避免Python IPC，但native崩溃会影响Node，必要时使用受监督worker/process隔离，不能仅因无Python就忽略回收。

## 6. 现有代码最值得先完善的七点

| 优先级 | 发现 | 证据 | 建议与状态 |
|---|---|---|---|
| P0 | Observed：ArticleService.dispose只abort并等待renderer，未登记全部static work；旧Renderer.close返回promise未完整await | [service.js:58](../../src/service.js)、[render.js:166](../../src/render.js)；上轮受控deferred实验 | Inferred：active operation set + 幂等dispose + 等请求/写盘/浏览器关闭，修复JSDoc与行为一致性 |
| P0 | Observed：rich capture把大多数非2xx一律变article-access，旧extractArticle对5xx为article-server | [capture.js:225](../../src/capture.js)、[articles.js:355–358](../../src/articles.js) | Inferred：统一HTTP分类；相同503不能在另一入口变成client失败 |
| P0 | Observed：createCapture已有progress，Standalone MCP captureAndSave未传回调；server只回最终text JSON | [capture.js:220](../../src/capture.js)、[capture-service.js:63](../../src/capture-service.js)、[server.js:28–34](../../src/server.js) | Inferred：把阶段事件接到MCP progress和有界诊断，不在stdout写普通日志 |
| P1 | Observed：rich browser HTTP仍走Node代发；新增provider只接fetchPage无法覆盖 | [capture-renderer.js:93–111](../../src/capture-renderer.js)、[capture-media.js:67](../../src/capture-media.js) | Inferred：固定地址低层provider共用，不迁移抽取/状态owner |
| P1 | Observed：imageSource计算多个候选后只返回一个；srcset以逗号切分 | [capture.js:85–103](../../src/capture.js) | Inferred：标准解析+同一occurrence候选列表，读取/解码失败才试下一候选，保持总预算 |
| P1 | Observed：captureAssets单个URL失败即保存failed；成功图片按hash去重并保positions | [capture-media.js:172–215](../../src/capture-media.js) | Inferred：保留现有去重/位置，增加attempts和selected reason；不要丢失败figure |
| P1 | Observed：rich请求链有独立会话通道，safeHeaders剔除Set-Cookie，默认createCapture未注入ArticleService.jar；asset请求未显式带上浏览器会话 | [capture-renderer.js:7、35、104–108](../../src/capture-renderer.js)、[capture.js:211–213、251](../../src/capture.js) | Inferred：补匿名会话跨导航/正文资源/原图的受控桥接测试；是否造成具体站点失败仍需复现，不据代码直接断言当前文章必然失败 |

**Observed，srcset最小反例**：输入URL为photo,large.jpg时，当前逗号切分会拆成photo和large.jpg两个来源；标准解析器保留完整URL和1600w。离线输出见 [srcset-probe.json](srcset-probe.json)。这个问题与反爬无关，换TLS provider不会修复。

**Inferred，会话修复范围**：只处理公开匿名会话和当前Node jar；不导入用户登录Cookie，不把所有Cookie发送到CDN。按domain/path/secure/expiry精确选择，跨源图片只接收其目标应有的匿名Cookie；Referer若需支持也来自受控页面来源和部署策略，不允许模型任意设置。browser/asset处的重复请求可通过有预算的响应复用减少，但必须遵守no-store和空间上限。

## 7. 建议的公共请求与抽取接口

**Inferred，连接提供者输入**：由Node解析并验证的url、addresses、method、内部允许headers、总deadline、编码/解码字节预算、AbortSignal。provider名称来自部署Config；模型只选择业务URL，不能传curlOptions、proxy、脚本、Cookie或TLS放宽开关。

**Inferred，连接提供者输出**：statusCode、逐项headers（保Set-Cookie）、有界bytes、finalUrl、连接地址/耗时诊断和已解压状态；错误返回受控typed code。Node继续逐hop处理Location、DNS和同源限制；连接复用必须证明不会逃逸新一次pin和会话策略。charset协商仍使用现有decode，缓存/Retry-After和pacer仍使用现有实现。

**Inferred，富文本输出继续为不可变ArticleSnapshot**：保持blocks、assets、positions、sourceHash和quality。候选抽取结果不是直接展示的整页HTML；最终首尾、层级、列表、表格和figure均需与原DOM证据对应。修改schemaVersion、持久化字段或block id策略时必须做显式迁移及审核失效验证，不能顺便改旧快照。

**Inferred，质量诊断应保存的事实**：取到了哪些阶段、HTTP/DOM各多少字节、选择了哪个范围、首尾样本hash、过滤了哪些类别、有哪些分页/图片失败、所用adapter/extractor版本和最终正文hash。对人显示可理解的reason；对Agent提供短摘要与分页events。字数/相似度是诊断指标，不能独立证明完整。

## 8. MCP 协议完善

**Observed**：当前[server.js](../../src/server.js)仅声明tools，工具列表没有outputSchema，成功结果为JSON text，错误为安全code；本机SDK 1.32.1 已有RequestHandlerExtra._meta/sendNotification、outputSchema、structuredContent和resource_link类型。因此常规progress和结构结果不需要先升级主版本。具体客户端是否完整呈现这些能力仍需互操作测试。

**Inferred，先做兼容增强**：给稳定结果声明outputSchema并返回有界structuredContent；为旧客户端保留同字段JSON文本兼容，按总序列化字节计算预算，不能复制整篇HTML两遍。错误保留现有code/isError，再增加可选runId与脱敏诊断引用，避免日志文本成为模型指令。

**Observed + Inferred，进度**：[MCP规范](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/86f6e0c675afea9a8f233e09b6faf566b126086c/docs/specification/2025-11-25/basic/utilities/progress.mdx#L12-L103)要求请求提供progressToken、数值递增、完成即停止；未知总量允许不发total。实现应使用递增事件序号作progress，message描述导航/等待正文/抽取/原图等实际阶段；不能把阶段计数反复重置，也不要伪造百分比。通知节流由部署配置控制；缺token客户端仍可读取分页events。

**Inferred，长任务**：第一步保持原工具同步语义，只补progress、取消和诊断。确实超过客户端预算时再增加可选start/status/events/cancel或协议tasks能力，不能把旧capture_source突然改成返回jobId。生命周期必须说明MCP断开后取消还是继续、重启如何恢复；复用现有任务状态机制，不另装外部MCP server监督器。协议tasks需协商客户端能力，不假设所有Agent都支持。

**Inferred，资源**：正文继续source_page有界分页；另为已归档资产提供按snapshotId/assetId读取的资源引用或有界预览。先校验快照hash和资产归属，再读取本地已归档bytes，默认不发新网络、不暴露磁盘路径/凭据；预览明确像素/字节/MIME预算并支持无视觉客户端降级。需要看原图的Agent不应只收到alt文本后被认为已理解图片。

**Inferred，工具权限**：文章捕获、读取快照、网络录制、凭据revealing和请求replay必须分别描述副作用。annotations是提示而非权限控制；录制会写盘，replay可能改远端状态，不能统一标成readOnly。默认诊断不能暴露Cookie/Authorization/原HAR；敏感revealing应由部署和显式管理操作约束。

## 9. 可独立交付与回滚的任务

| 任务 | 主要文件 | 验收标准 | 回滚 | 状态 |
|---|---|---|---|---|
| T0 生命周期收尾 | service.js、render.js、server.js及生命周期测试 | deferred fetch/取消/关闭竞争/写盘完成后dispose才返回；重复关闭安全，stdin关闭不留浏览器 | 回退该独立补丁 | NEXT |
| T1 共用HTTP错误分类 | articles.js、capture.js、fetch.js及对等测试 | 两入口401/403/404/429/503/超时/取消映射一致，五失败族不退 | 回退分类补丁 | NEXT |
| T2 MCP进度与诊断 | server.js、capture-service.js、tools.js、config.js | 有token收到递增事件；无token仍工作；完成不再发；日志脱敏、限量、stdout纯协议 | 关闭通知/恢复原结果格式 | NEXT |
| T3 请求provider接口 | capture-media.js、fetch.js、config.js、provider模块 | Node默认输出不变；旧文本、rich文档、XHR与图片全部走同一策略；provider不可跳过URL/IP/字节限制 | 选回Node | NEXT |
| T4 TLS候选PoC | 隔离provider集成测试 | 固定IP/SNI、禁代理、逐hop、Set-Cookie、解压上限、abort、native失效与回收通过，再测真实403文章 | 不打包/禁provider | NEXT |
| T5 图片候选与会话 | capture.js、capture-media.js、capture-renderer.js | srcset逗号/descriptor正确；首选失效回退；同图多位置；跨源不串Cookie；保持失败占位和预算 | 禁候选回退/保原记录 | NEXT |
| T6 抽取影子比较 | 可选extractor模块、离线夹具 | Gov Saúde不被候选覆盖为空；R7减少推荐内容；分页/列表/表格/图注/原图不丢 | 关闭候选，保Readability | NEXT |
| T7 快照与资源 | capture-service.js、server.js、contracts | 归属/hash/分页预算/预览类型校验；默认不返回任意路径/原HAR/秘密 | 关闭resources，保旧分页 | NEXT |
| T8 回归与发布文档 | toolkit README中英、interop/回归脚本 | 无Python默认测试仍通过；Node支持范围内验证；新provider独立平台矩阵与一键降级说明 | 发布配置退回Node | NEXT |

**Inferred，回归策略**：原28链接保留26成功+2正确短文，不允许新增失败；但这是旧文本基线，rich层另建正文块顺序、原图hash/occurrence、caption/credit、列表表格、SPA、分页、无图、受限页和人工全文完整性的验收。保存内容可重复离线检查，真实网络只作有预算可分类的补充，不把网络波动当单元测试失败。

**Inferred，负向验收**：私网/IPv4-mapped/DNS64/重绑定/跨源redirect/代理环境必须拒绝；证书错误不能降级；Cookie不可跨域泄漏；缺native/Python/浏览器返回可操作不可用码；禁止自动pip/运行时/浏览器安装；超过编码/解码/总在飞字节预算应停止读取；受限正文不能因候选的JSON-LD/第三方API变成passed。

**Assumed，投入估算**：T0–T2约1–2工程日；T3–T4约2–4工程日并取决于native库是否提供可验证pin能力；T5约1–2工程日；T6约1–2工程日加人工语义核对；T7–T8约1–2工程日。由toolkit maintainer、provider owner、CI owner与文章编辑分别承担实现、连接安全、平台验证和语义验收；这些是待分配角色和估算，不是已承诺日期。

## 10. Go / No-Go 与本轮交付

**Inferred，Go**：先实施T0/T1/T2和T5的小片段；它们有当前代码缺口及离线反例支持。保持原协议与快照的向后兼容，不需要先引入Python或完整爬虫框架。

**Inferred，条件Go**：TLS provider必须证明目的地址固定、无隐式代理、完整headers/bytes、取消和预算，再证明真实文章增益且旧回归不退。Defuddle必须保持影子模式直到站点级质量证据通过。Impit本轮网络可运行但pin条件未通过，不能据此上线；impers本轮只审源码，没有运行通过结论。

**Inferred，No-Go**：整体嵌入Crawlee/Crawl4AI；用扁平Markdown替换富文本主输出；默认自动安装运行时/浏览器/native库；只改旧文本fetch却声称工作台修复；凭请求200、字数多或HTTP2就判全文完整。

**Observed，本轮范围与复现**：仅新增此reports目录；产品58个源码/测试/清单文件以SHA256核对，结论见evidence-manifest.json。实验脚本和上游源码副本位于[C:/Users/haige/AppData/Local/Temp/article-toolkit-github-review-20261017](C:/Users/haige/AppData/Local/Temp/article-toolkit-github-review-20261017/)，没有放进npm files。实验依赖只在该Temp包内；29个已安装package metadata的许可标签为MIT/ISC/BSD-2-Clause/Apache-2.0，不等于所有native传递源码的完整审查。详细结果见[experiments.json](experiments.json)。本轮未重跑原240测试，未运行真实生图、登录、验证码或付费操作。

**Inferred，下一步**：若开始跨模块实施，建议单独确认一个OpenSpec change，收敛T0–T3的接口、诊断与验收后分片实施；本报告没有改写原article-image-understanding-workbench，避免把新provider架构默认为第一期既定实现。
