# GitHub 候选源码评审：article-image-toolkit 的增量完善

日期：2026-10-17。范围：只读 GitHub 插件搜索与固定 commit 源码审阅；未安装候选依赖，未运行候选代码，未修改产品、测试、配置、OpenSpec 或控制文件。Observed 表示代码证据，Inferred 表示基于代码的架构推断，Assumed 表示尚待实验；本报告没有把源码能力当作本机运行结果。

## 候选表与结论

| 候选及固定 commit | 职责、许可证正文 | 对当前项目的建议 | 主要证据 |
|---|---|---|---|
| apify/got-scraping，031f04c9b8b1e8c4a18b70c890c31ba913ea59c4 | Observed：Node ESM Got 包装；package.json 声明 Apache-2.0，但这个 commit 的整棵 tree 未找到 LICENSE/NOTICE 正文。 | Inferred：不直接加入默认请求层；可以成为严格配置后的小型比较对象。其 Node TLS 配置不是已验证的完整 Chrome ClientHello。 | [类型与 ESM](https://github.com/apify/got-scraping/blob/031f04c9b8b1e8c4a18b70c890c31ba913ea59c4/package.json#L1-L29)、[TLS 配置](https://github.com/apify/got-scraping/blob/031f04c9b8b1e8c4a18b70c890c31ba913ea59c4/src/hooks/tls.ts#L218-L240)、[整棵 tree](https://api.github.com/repos/apify/got-scraping/git/trees/031f04c9b8b1e8c4a18b70c890c31ba913ea59c4?recursive=1) |
| apify/crawlee，02899241d570624a0ce0b77dbcb44b9d58a98ade | Observed：爬取运行时，包含请求管理器、调度、会话、HTTP/浏览器客户端；LICENSE.md 是 Apache-2.0 正文。 | Inferred：不整体嵌入；只借鉴资源感知并发、生命周期、HTTP-client 接口。其 Impit 客户端提示了另一个可以独立研究的原生 TLS provider。 | [许可证](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/LICENSE.md#L1-L9)、[会话创建](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/packages/basic-crawler/src/internals/basic-crawler.ts#L1192-L1204)、[调度 owner](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/packages/basic-crawler/src/internals/basic-crawler.ts#L1233-L1249) |
| adbar/trafilatura，e2f85c965662c7df26b73290ef175b2c2a5fdca6 | Observed：Python 正文抽取器，也附带独立下载器；LICENSE 为 Apache-2.0。README 明示早于 v1.8.0 的版本采用 GPLv3+。 | Inferred：适合作为离线影子抽取器，输入已抓到的 HTML；暂不替代 Node 主抽取和原图归档。 | [许可证](https://github.com/adbar/trafilatura/blob/e2f85c965662c7df26b73290ef175b2c2a5fdca6/LICENSE#L1-L9)、[许可历史](https://github.com/adbar/trafilatura/blob/e2f85c965662c7df26b73290ef175b2c2a5fdca6/README.md#L108-L112)、[已有 HTML 入参](https://github.com/adbar/trafilatura/blob/e2f85c965662c7df26b73290ef175b2c2a5fdca6/trafilatura/core.py#L482-L551) |
| unclecode/crawl4ai，94b67888ca8b335ff2121423a50e06dd27661922 | Observed：Python 浏览器/HTTP 爬取、缓存、分发、抽取运行时；LICENSE 是 Apache-2.0 文本加 Attribution Requirement。 | Inferred：不整体集成。可借鉴图像候选分组和结果诊断字段；额外署名条款需单独确认并落实，不能只写“标准 Apache”。 | [许可证附加段](https://github.com/unclecode/crawl4ai/blob/94b67888ca8b335ff2121423a50e06dd27661922/LICENSE#L51-L67)、[结果类型](https://github.com/unclecode/crawl4ai/blob/94b67888ca8b335ff2121423a50e06dd27661922/crawl4ai/models.py#L130-L169) |
| mozilla/readability，ab4027a8b37669745016869a37a504727992b2ba | Observed：DOM 正文抽取；LICENSE.md 为 Apache-2.0，NOTICE 保留 Arc90/Mozilla 署名；当前 toolkit 已依赖 @mozilla/readability 0.6.0。 | Inferred：继续作为当前主抽取器；完善结构化保真、证据、原图，而不是再嵌一个同职责爬虫。 | [许可证](https://github.com/mozilla/readability/blob/ab4027a8b37669745016869a37a504727992b2ba/LICENSE.md#L1-L9)、[NOTICE](https://github.com/mozilla/readability/blob/ab4027a8b37669745016869a37a504727992b2ba/NOTICE#L1-L3)、[媒体 URL 修复](https://github.com/mozilla/readability/blob/ab4027a8b37669745016869a37a504727992b2ba/Readability.js#L503-L534) |

## 1. got-scraping：TLS 配置真实存在，不能视为完整浏览器指纹等价

Observed：src/hooks/tls.ts 导入 node:tls/createSecureContext；tlsHook 按 UA 选择 Firefox/Chrome/Safari，并设置 ciphers、signatureAlgorithms、ecdhCurve、minVersion/maxVersion、secureOptions、requestOCSP。它确实修改 TLS，不是只改 HTTP header。但这条实现仍受 Node/OpenSSL 的 ClientHello 能力约束，源码没有给出完整浏览器 ClientHello 的等价证明。[源码 3-20、218-240](https://github.com/apify/got-scraping/blob/031f04c9b8b1e8c4a18b70c890c31ba913ea59c4/src/hooks/tls.ts#L3-L20)

Inferred：应把 got-scraping 描述为“调整 Node TLS 配置并生成浏览器 headers”，不能宣称它等同 curl_cffi 的 impersonate。在本轮没有抓包/JA4/目标站对比实验，因此它能否改变当前 403 属于 Assumed；验证方法是同一 URL、相同 header 和固定地址，Node 原生/Got 严格配置/原生 impersonation 三路 5 次比较，保留握手和文章质量证据。

Observed：其默认值不符合当前严格 HTTP 请求语义：src/index.ts 43-64 开启 HTTP/2、设置 rejectUnauthorized:false 和 insecureHTTPParser:true。80-97 还修改 Got Options.prototype.url setter，在 setter 执行期间临时替换 global.decodeURI。虽然这不是始终替换 global，但导入包已有全局原型副作用。[默认与副作用](https://github.com/apify/got-scraping/blob/031f04c9b8b1e8c4a18b70c890c31ba913ea59c4/src/index.ts#L43-L97)

Observed：buffer 响应、可取消请求与 stream API 在该包装器类型中存在：types.ts 8-30 提供 CancelableRequest<Response<Buffer>> 与 isStream，60-68 定义 stream 函数。下游 Got v14.2.1 的固定 commit 8da9912fc18ea12daa8c11755e85cd14e26bb8b3，core/options.ts 1512-1519 接受 AbortSignal，1633-1640 接受 dnsLookup，2452 传到 Node lookup；core/index.ts 266-277 用 signal.destroy，873-889 收集 rawBody。这里审阅的是声明范围下限 v14.2.1，不是已安装的实际依赖锁版本。[包装器 API](https://github.com/apify/got-scraping/blob/031f04c9b8b1e8c4a18b70c890c31ba913ea59c4/src/types.ts#L8-L68)、[Got signal](https://github.com/sindresorhus/got/blob/8da9912fc18ea12daa8c11755e85cd14e26bb8b3/source/core/options.ts#L1512-L1519)、[Got DNS 注入](https://github.com/sindresorhus/got/blob/8da9912fc18ea12daa8c11755e85cd14e26bb8b3/source/core/options.ts#L1633-L1640)、[取消落实](https://github.com/sindresorhus/got/blob/8da9912fc18ea12daa8c11755e85cd14e26bb8b3/source/core/index.ts#L266-L277)、[rawBody](https://github.com/sindresorhus/got/blob/8da9912fc18ea12daa8c11755e85cd14e26bb8b3/source/core/index.ts#L873-L889)

Inferred：API 足以构造保留 headers/bytes 的适配器，但并不自动符合现有 createPublicRequest。至少需要显式证书验证、禁宽松 parser、followRedirect:false、关闭自有 retry/cache/cookie、保留 Node jar/pacer，流式字节上限，确保 HTTP/2 的 ALPN 探测和实际连接都使用已校验 IP。其 http2Hook 会转到 http2-wrapper.auto，代理另走 resolveProtocol，因此只证明普通 HTTP lookup 可注入是不够的。[HTTP/2 分支](https://github.com/apify/got-scraping/blob/031f04c9b8b1e8c4a18b70c890c31ba913ea59c4/src/hooks/http2.ts#L9-L28)

Observed：当前 commit 没有许可证正文；package metadata 声明 Apache-2.0 不足以完成发布包归属审查。Assumed：若仍进入试验，应检查指定 npm tarball 的 license/NOTICE 与依赖清单，若缺失向上游确认。未经此项确认不建议 vendoring。

## 2. Crawlee：完整框架会形成第二套 owner

Observed：BasicCrawler 默认可打开自有 RequestQueue（basic-crawler.ts 305-307、1898-1903），创建自有 SessionPool（1192-1204），并驱动自有 AutoscaledPool（388、1233-1249）；Session 的 cookieJar 默认 new tough-cookie.CookieJar（session.ts 14、121-154）。这不是单一 HTTP helper。[请求管理器](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/packages/basic-crawler/src/internals/basic-crawler.ts#L289-L307)、[自有池](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/packages/basic-crawler/src/internals/basic-crawler.ts#L1192-L1204)、[CookieJar 默认](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/packages/basic-crawler/src/internals/session-pool/session.ts#L1-L17)

Observed：HTTP Crawler 结果支持 body:string|Buffer、response 与 contentType；其网络请求将内部取消 signal 交给 HttpClient。因而字节/headers/取消并非缺失，但其 body 也会经历编码转换，不能把框架的所有 body 字段等同线上原始 bytes。[HTTP 结果](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/packages/http-crawler/src/internals/http-crawler.ts#L207-L226)、[取消传递](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/packages/http-crawler/src/internals/http-crawler.ts#L938-L958)

Observed：HttpCrawler 的 ignoreTlsErrors 默认 true，saveResponseCookies 默认 true（384-392）。这与当前 transport 的证书校验/Node jar owner 需要明确对齐。[默认值](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/packages/http-crawler/src/internals/http-crawler.ts#L384-L392)

Inferred：把完整 Crawlee 加在现有 service/pacer/jar/cache/renderer 外面会增加第二套重试、调度、会话、持久化和停止语义。可以注入其接口来避免一部分重复，但那意味着适配整个框架，短期比自有窄 transport adapter 更昂贵。不建议整体集成；有价值的是参考其资源感知并发、owner/injected 分离与结构化诊断。

Observed：Crawlee 的可选 @crawlee/impit-client 是更小的后续候选；其源码 102-116 按 options 控制 followRedirects 并透传 signal。官方说明推荐 Impit 作为 got-scraping 的 successor，并把 TLS ClientHello 模拟归给 patched rustls。此处只是候选发现；没有审查 impit 自身许可证/二进制/DNS pin，不作采纳结论。[小客户端](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/packages/impit-client/src/index.ts#L102-L119)、[官方比较](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/docs/guides/impit-http-client/impit-http-client.mdx#L14-L31)、[TLS 实现说明](https://github.com/apify/crawlee/blob/02899241d570624a0ce0b77dbcb44b9d58a98ade/docs/guides/impit-http-client/impit-http-client.mdx#L122-L126)

## 3. Trafilatura：已有 HTML 的抽取评审，不需要替换网络层

Observed：extract(filecontent, url, ...) 接收 HtmlInput，支持 text/HTML/XML/Markdown 等输出；include_tables 默认 true，include_images 默认 false，include_formatting/include_links 可选，include_comments 默认 true。bare_extraction 返回 Document 和未序列化 body 树，随后 load_html(filecontent) 解析已有输入。这提供了独立于 downloader 的抽取入口。[公共入口](https://github.com/adbar/trafilatura/blob/e2f85c965662c7df26b73290ef175b2c2a5fdca6/trafilatura/core.py#L482-L551)、[body 树与载入](https://github.com/adbar/trafilatura/blob/e2f85c965662c7df26b73290ef175b2c2a5fdca6/trafilatura/core.py#L337-L387)

Observed：include_images 能保留部分图片语义，但 handle_image 只输出 src、alt、title；image_src 优先 data-src/src，且必须匹配图片扩展名，才考虑其他 data-src 属性。这里没有现有 toolkit 的完整 srcset/picture 原图选择、hash、MIME/像素验证、caption/credit 与 occurrences 关系。[图片重建](https://github.com/adbar/trafilatura/blob/e2f85c965662c7df26b73290ef175b2c2a5fdca6/trafilatura/main_extractor.py#L487-L505)、[来源选择](https://github.com/adbar/trafilatura/blob/e2f85c965662c7df26b73290ef175b2c2a5fdca6/trafilatura/utils.py#L475-L489)

Inferred：可以把已保存的同一份 HTML 送入 Trafilatura，不发第二次外网请求，不产生另一套 jar。固定 include_comments:false、include_images:true、include_formatting:true、include_links:true，输出 HTML/XML 或 Document，再与当前正文块和图片位置比较。若直接用默认 txt，会丢富文本且混入评论风险；不能把“支持图片”当作原图资产完整归档。

Observed：独立 downloader 的安全实现值得参考，但不应无差别导入：downloads.py 118-145 检查实际 socket peer，能处理 IPv4-mapped IPv6；113-115 在代理存在时关闭该层检查。其 urllib3 下载器流式限解压后字节（222-235），但 SSL 错误有专用“重试不校验证书”信号（244-248）。[peer 检查与代理](https://github.com/adbar/trafilatura/blob/e2f85c965662c7df26b73290ef175b2c2a5fdca6/trafilatura/downloads.py#L107-L145)、[读取预算与 SSL 分支](https://github.com/adbar/trafilatura/blob/e2f85c965662c7df26b73290ef175b2c2a5fdca6/trafilatura/downloads.py#L217-L248)

Assumed：收益需要一次离线对比决定，而不是读 README。输入现有 28 篇保存 HTML，比较段落覆盖、首段噪声、标题/列表/表格、图片 occurrence、受限页误判、运行时间和内存。只有补回 Readability 的真实缺失且没有新增噪声，才启用按失败原因选择的 extractor fallback；不以字数最长胜出。需要 Python+lxml 部署成本与异常/取消隔离，纯 Node 默认仍不依赖它。

## 4. Crawl4AI：图像分组可借鉴，整体框架与额外许可不适合直接套用

Observed：CrawlResult 包含 html、cleaned_html、media、links、status_code、response_headers、redirected_url、network_requests、console_messages、cache_status 等。它比扁平 Markdown 更适合诊断；但没有直接提供当前项目的不可变 blocks/assets/positions 关系。[类型](https://github.com/unclecode/crawl4ai/blob/94b67888ca8b335ff2121423a50e06dd27661922/crawl4ai/models.py#L130-L169)

Observed：process_image 处理 src/data-src/srcset/picture/source，把多个变体设为相同 group_id，并按尺寸、alt、格式等打分。这个“同一图片 occurrence 的多个来源候选”值得参考；其 score 阈值会主动剔除图片，不能无评测照搬到“完整获取原图”的要求。[候选与阈值](https://github.com/unclecode/crawl4ai/blob/94b67888ca8b335ff2121423a50e06dd27661922/crawl4ai/content_scraping_strategy.py#L440-L545)

Observed：arun_many 的 stream=True 是逐 URL 的结果流，不是 HTTP 响应字节流；不能用该开关证明压缩炸弹或单页大小预算已受控。async_crawler_strategy 支持 raw:/file://，浏览器管理器有独立 profile/context/cookie/proxy 与 browser lifecycle。直接暴露整个工具/API 会超出当前仅公网 URL 的范围。[结果流](https://github.com/unclecode/crawl4ai/blob/94b67888ca8b335ff2121423a50e06dd27661922/crawl4ai/async_webcrawler.py#L1021-L1036)、[file/raw 入口](https://github.com/unclecode/crawl4ai/blob/94b67888ca8b335ff2121423a50e06dd27661922/crawl4ai/async_crawler_strategy.py#L440-L512)、[context 参数](https://github.com/unclecode/crawl4ai/blob/94b67888ca8b335ff2121423a50e06dd27661922/crawl4ai/browser_manager.py#L1330-L1396)

Observed：LICENSE 54-65 额外规定所有分发、出版及公开使用要在显著且可访问位置展示指定署名，CLI 包括 help/usage。Inferred：这不等于非商用禁令，但确有需要落实的附加义务，不能用 package license 标签抹掉。整套框架没有本次可证明的增量收益；建议只借鉴设计，不执行安装，不引入爬取/LLM/验证码相关套件。

## 5. Readability：继续主抽取，强化输出保真和安全呈现

Observed：parse 返回 content HTML、textContent、metadata；会改写传入 DOM，官方建议 clone。媒体处理会保留并绝对化 img/picture/figure/source 的 src/srcset。当前 capture.js 已使用 cloneNode、typed inline marks、list/table/figure blocks，与 Readability 的 DOM 结果兼容。[返回与 clone](https://github.com/mozilla/readability/blob/ab4027a8b37669745016869a37a504727992b2ba/README.md#L42-L62)、[媒体处理](https://github.com/mozilla/readability/blob/ab4027a8b37669745016869a37a504727992b2ba/Readability.js#L503-L534)

Observed：Readability 官方明确不以 sanitizer 为职责；JSDOM 脚本和资源加载默认关闭并建议保持关闭，展示原始 content HTML 时需要 sanitizer/CSP。当前 toolkit 的 typed blocks 只保留有限 marks，不应为了换库把原始第三方 HTML 直接塞进 UI。[安全职责](https://github.com/mozilla/readability/blob/ab4027a8b37669745016869a37a504727992b2ba/README.md#L100-L109)

Inferred：优先完善根容器判定和两个现有抽取入口的一致性，保存每步决策、候选数量和质量信号，保留可离线复测 HTML；替换整个网络与抽取系统不是必需条件。官网当前 commit 是研究依据，不代表应该升级现有锁定 0.6.0；升级须以原测试/回放验证。

## 与当前代码对照后的落地优先级

Observed：当前 fetch.js 已有 bytes+headers 解码、缓存、Retry-After、Node jar/pacer；capture-media.js 36-55 验证所有解析 IP 和 DNS64，67-98 对每跳重新校验并限制同源，103-113 固定 lookup 并禁共享池；capture.js 85-105 已经选择 picture/srcset/原图属性，captureAssets 172-212 保留原图验证、hash 和多处位置。候选评审不能把这些现有能力当作尚未建设。

1. Inferred，P0：保持 Node 作为 URL、重定向、jar、cache、pacer、大小预算与错误族的 owner；补齐静态请求在 dispose 中的追踪与结算。增加每步结构化 evidence，禁止原网页内容/凭据进入默认诊断。
2. Inferred，P1：建立薄 HTTP transport 接口，只替换请求字节来源；返回 status/headers/bytes/final URL/timings，保持代理和 headers 不对 Agent 开放。原生 TLS 候选单独比测 Impit、impers、自有 Scrapling/curl bridge，先验许可证、安装与 DNS pin。
3. Inferred，P1：建立已有 HTML 的影子 extractor 比较，不增加外网；Readability 继续默认，Trafilatura（及主代理审阅的 Defuddle）只输出候选和可解释差异，不自动以字数择优。
4. Inferred，P2：原图数据保留一个 occurrence 对多个 candidate，记录选中原因、尺寸/字节/MIME、失败码与 caption/credit；从 Crawl4AI 借鉴 group_id 思路，不复制其删除阈值。
5. Assumed：候选只有通过同一 28 篇、同一已保存 HTML、无私网访问与无自动安装的验收后才进入发布。不能将本次静态代码审阅标为集成已验证。

## 后续必须验证的四个实验

| 实验 | 输入与验收 | 状态 |
|---|---|---|
| TLS provider 比较 | 相同 UA/headers、固定 IP、同 URL 各 5 次；403 目标必须是真实文章全文 | Assumed，未执行 |
| 离线 extractor 比较 | 28 份相同 HTML；首段噪声、段落/列表/表格、所有图片位置、误判限制页、时间/内存 | Assumed，未执行 |
| 网络安全负例 | 私网、IPv4-mapped IPv6、DNS64、DNS rebinding、跨源跳转、环境代理、HTTP/2 探测连接 | Assumed，未执行 |
| 生命周期与预算 | abort/dispose/子进程故障、流读取上限、解压后上限、请求并发和父退出回收 | Assumed，未执行 |

## 精简总结

- 结论：当前应补薄接口和质量证据，保留现有 Node/Readability/patchright 核心；Crawlee/Crawl4AI 不宜整体嵌入，Trafilatura 只作为离线影子抽取候选。
- 验证：五个指定候选已通过 GitHub 插件固定到 commit 并审阅相关源码及许可证；无安装、无候选运行、无产品编辑。
- 剩余风险：got-scraping 许可证正文缺失、默认关闭 TLS 验证；Crawl4AI 额外署名；原生 TLS 候选 DNS pin/分发仍需实验。
- 下一步：由主任务汇总独立候选和当前代码缺口，确定先实施的最小切片。
