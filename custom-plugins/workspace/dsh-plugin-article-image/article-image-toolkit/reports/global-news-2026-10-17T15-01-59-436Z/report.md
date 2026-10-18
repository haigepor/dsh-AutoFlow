# 全球新闻站点实测报告

日期：2026-10-17。结论来自本机当前工具包的真实 MCP stdio 调用。每站一篇，共 16 篇；这是样本结果，不能外推为整站永久支持率。新闻日期跨度不同；CNN 样本是官方节目文字实录，DW 样本是公开 AMP 文章。

## 结论

编号正文成功 **7/16**；富文本快照返回 **3/16**，三份都是 **partial**，没有 passed。CBS 下载了 6 张 1240×826 JPEG；NPR 只有 1 张 100×100 JPEG 成功、另外 3 个候选资产下载失败；新华社样本没有提取到图片。这些数字不能表述为“3 篇完整富文本与原图全部成功”。

Observed：编号正文、富文本抽取和图片下载的结果差异很大。Inferred：当前问题同时涉及本机网络/解析条件和富文本实现，不能简单认定整个工具包无效，也不能仅凭能打开页面或拿到正文就认定配图来源完整可用。

## 测试方法与边界

使用工具包公开的 start() 入口启动真实 stdio MCP 服务，harness 同代的 @modelcontextprotocol/client v2 连接，实际调用 article_image_fetch、article_image_capture_source、article_image_source_page 和 article_image_diagnostics。没有用网页搜索返回的正文替代抓取。文章链接由搜索结果及既有公开 fixture 发现，随后请求原发布站；没有访问不明镜像站获取正文。

两个链路各并发 2，部分时间并行，总并发最多 4。两条链路均为每请求 60 秒、渲染 120 秒、单调用总预算 180 秒，缓存关闭，fresh context；图像、像素等限制保持默认，测试数据总存储上限 1 GiB。文本采用 fallback；富文本始终走现有隔离渲染内核。进度和诊断不经过模型分析，不生成图片。

每次调用结束后，在同一 MCP 进程分页导出诊断；成功快照分页读回块和资产，与私有磁盘快照核对，全部已下载字节做 SHA-256 与长度校验。MCP 进程现已退出，报告中的 diagnosticId 用于关联已导出的日志，不能在新进程重新查询。正文、图片字节和源 HTML 留在隔离私有测试目录，报告不复制全文、Cookie、请求头或图片签名查询参数。

CNA 的首次候选 slug 后来按搜索原链接更正并补测；最终表使用更正后的补测结果，首轮日志仍保留。补测不计作第 17 个站点。其他站点没有成功后挑选替代文章来提高统计。

## 逐篇结果

“图片成功/失败”为资产数量；成功资产不自动代表正文主图，NPR 的成功资产仅为 100×100。字符数是各链路自身的文本投影，标题、图注和段落分割不同，不能直接按字数差判断丢文。

| # | 原站文章 | 地区/语言 | 编号正文 | 耗时 | 富文本结果 | 图片成功/失败 | 耗时 |
|---|---|---|---|---|---|---|---|
| 1 | [CBS News](https://www.cbsnews.com/news/artemis-ii-mission-astronauts-still-awed-moonshot/) | 北美/en | 45 段 / 8914 字符 | 5.7s | 38 段 / 8095 字符；partial | 6 / 0 | 105.2s |
| 2 | [新华社](https://www.news.cn/tech/20260129/c14ec2642dec4be7942f807dc586e1e9/c.html) | 东亚/zh | 38 段 / 3567 字符 | 0.9s | 1 段 / 3567 字符；partial | 0 / 0 | 121.5s |
| 3 | [Associated Press](https://apnews.com/article/dadb5f9499fa9b52200baada0fdf1f15) | 北美/en | 16 段 / 4042 字符 | 7.7s | article-access | — | 6.4s |
| 4 | [France 24](https://www.france24.com/en/france/20260818-sophie-adenot-set-to-become-first-french-female-astronaut-to-venture-outside-iss) | 欧洲/en | 20 段 / 2670 字符 | 6.8s | article-render | — | 60.1s |
| 5 | [CNA](https://www.channelnewsasia.com/world/nasa-artemis-ii-launch-moon-us-6032266) | 东南亚/en | article-network | 21.6s | article-render | — | 22.5s |
| 6 | [ABC Australia](https://www.abc.net.au/news/2026-03-29/australia-support-nasa-artemis-moon-mission/106508360) | 大洋洲/en | article-url-blocked | 0.0s | article-render | — | 21.7s |
| 7 | [Al Jazeera](https://www.aljazeera.com/news/2026/4/1/nasas-artemis-ii-lifts-off-to-the-moon) | 中东/en | article-url-blocked | 0.0s | article-render | — | 21.7s |
| 8 | [DW](https://amp.dw.com/de/artemis-crew-kehrt-nach-mondumrundung-zur-erde-zurueck-orion-trump-carney/a-76746113) | 欧洲/de | article-network | 21.6s | article-render | — | 21.7s |
| 9 | [EL PAÍS](https://elpais.com/ciencia/2026-03-24/la-nasa-revela-sus-planes-para-crear-la-primera-colonia-humana-en-la-luna.html) | 欧洲/es | article-url-blocked | 0.0s | article-render | — | 21.7s |
| 10 | [Folha de S.Paulo](https://www1.folha.uol.com.br/turismo/2026/10/roteiro-de-36-horas-no-lago-de-como-na-italia-destaca-vilarejos-arte-e-gastronomia.shtml) | 南美/pt | 59 段 / 12469 字符 | 2.7s | article-restricted | — | 23.7s |
| 11 | [News24](https://www.news24.com/life/passengers-and-the-real-life-science-of-deep-space-travel-20161222) | 非洲/en | article-network | 21.0s | article-render | — | 21.7s |
| 12 | [South China Morning Post](https://www.scmp.com/news/world/united-states-canada/article/3346456/nasa-clears-artemis-moon-rocket-april-launch-4-astronauts) | 东亚/en | article-network | 21.6s | article-render | — | 21.6s |
| 13 | [NPR](https://www.npr.org/2025/06/06/nx-s1-5424751/private-lunar-lander-from-japan-crashes-into-moon-in-failed-mission) | 北美/en | 28 段 / 5201 字符 | 3.8s | 33 段 / 5671 字符；partial | 1 / 3 | 32.6s |
| 14 | [The Guardian](https://www.theguardian.com/science/2024/may/01/astronauts-could-run-round-wall-of-death-to-keep-fit-on-moon-say-scientists) | 欧洲/en | article-network | 21.6s | article-render | — | 21.7s |
| 15 | [BBC News](https://www.bbc.co.uk/news/articles/clyrdkxvmmpo) | 欧洲/en | article-url-blocked | 0.0s | article-render | — | 22.5s |
| 16 | [CNN](https://transcripts.cnn.com/show/se/date/2024-04-08/segment/04) | 北美/en | 354 段 / 45722 字符 | 2.5s | article-render | — | 60.1s |

## 发现一：新华社的结构损失可以在同一 HTML 上重放

Observed：线上编号正文 38 段、3,567 字符，富文本只有 1 个 paragraph 块、仍是 3,567 字符。原 HTML 没有 article/main 语义容器，#detailContent 唯一且包含 39 个 p。Readability 处理后出现 38 个嵌套 p。对同一份刚抓到的 HTML 做离线重放：通用路径 1 段，已有站点适配机制指定 #detailContent 后 38 段，两者正文去空白后完全相同。

代码依据：[默认正文等待](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-renderer.js:82)只匹配 article/main；[富文本根节点选择与 Readability](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture.js:139)及[段落分支](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture.js:184)会把外层 p 当作一个文本块，未保留其内部块结构。该实例需要优化默认结构遍历，并让非语义容器站点的就绪检测采用实际正文区域。已有 adapter 是可验证的临时适配途径。

离线重放不是新的浏览器/MCP 成功，也没有开启生产站点规则；不得将 38 段离线结果替换主表的 1 段线上结果。原始数据见 xinhua-replay.json，源 HTML 保留在私有目录。

## 发现二：AP 的匿名会话链路存在可验证差异

Observed：文本路径成功取得 16 段，富文本返回 article-access。额外通过原工具包 HTTP 传输复查得到：第一次请求不含 Cookie，HTTP 403 且响应含 Set-Cookie；工具包记录匿名 Cookie 后的第二次请求为 HTTP 200。探针只保存“是否有 Cookie”的布尔值，不保存 Cookie 内容。

代码依据：[文本路径的匿名会话重试](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/fetch.js:75)已经实现；[富文本响应头处理](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-renderer.js:8)移除 Set-Cookie，[独立富文本内核构造](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-service.js:47)没有把 ArticleService 的匿名 jar 传入。Inferred：该差异是本次 AP 成败分叉的强候选原因；后续应以保留匿名会话的 A/B 测试确认，不能把它直接解释为缺少登录账号，也不应先接验证码服务。

## 发现三：NPR 原图 HTTP 403，单加 Referer 未解决

Observed：三份失败资产来自 npr.brightspotcdn.com，错误为 image-download。对其中一张原图，用同一安全传输分别发默认 GET 与增加图片 Accept/来源 Referer 的 GET，均为 HTTP 403、text/html、986 字节。已下载的 100×100 JPEG 不能补足正文大图。

因此，不能承诺“补 Referer 即可修好”。需要继续比较源站图片会话、候选 URL 与传输特征；图片诊断还应记录脱敏的 HTTP 状态与 MIME，而不只是 image-download。探针没有改变生产抓取参数，见 content-probes.json。

## 发现四：网络失败会被富文本外层统一包装成 article-render

Observed：文本失败为 article-network 5 篇、article-url-blocked 4 篇。富文本失败为 article-render 11 篇、article-access 1 篇、article-restricted 1 篇。11 个 article-render 的文档请求诊断中，9 个是 article-network，France 24 与 CNN 是 article-timeout。Folha 的受限判定保留为 article-restricted，没有尝试绕过。

代码依据：[导航异常翻译](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-renderer.js:140)保留的外层代码比资源诊断粗，不能据此认定 Chromium 本身不可用；同进程的 CBS/NPR 已成功输出快照。后续应让顶层错误保留最相关的主文档失败码，同时保留完整的阶段诊断。

还有一个架构限制：[资源拦截](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-renderer.js:94)把请求交给地址固定的 Node HTTP 传输，Chromium 负责执行和 DOM。这不是浏览器自己的完整网络栈；本测试不能证明普通 Chrome 直连同样失败，也不能证明已经获得浏览器 TLS 指纹。

## 网络与 DNS 观察

Observed：ABC 的一次本机解析同时返回公网 IPv4 和 2001:: 开头、ipaddr 分类为 teredo 的 IPv6。[公网策略](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-media.js:37)拒绝任何非允许地址结果，能解释这种条件下的 article-url-blocked。其他几站后续 DNS 查询出现不同结果，不能用后续结果回推每次调用时的答案。通过同一工具包访问 Cloudflare DoH 的四次旁证均超时，未取得可用于对照的独立解析答案。

Inferred：当前解析或路由环境值得先核查；本轮没有足够证据把全部失败定性为 DNS 污染，也没有关闭 SSRF、公网校验、同源跳转规则或使用登录态来制造成功。

## 建议的后续顺序

1. 修复富文本嵌套段落与非语义容器就绪检测；把本次新华社结构制成最小离线 fixture，保证文本与块结构都不丢失。
2. 对齐两条链路的匿名 Cookie 会话，围绕 AP 首次 403/匿名重试 200 做真实 A/B；继续拒绝登录墙、付费墙与交互式验证码。
3. 主文档错误码透传；图片失败补充 HTTP 状态、MIME 与候选序号诊断，并区分正文主图和缩略图。
4. 单独检查本机 DNS/出站网络后，再对失败站点复测。每站至少再选两篇不同模板，之后才讨论整站支持率或是否新增 TLS provider。

测试执行与结果导出为 DONE；上述修复为 NEXT，本轮没有修改工具包生产源码、配置、依赖、工作台样式或任何原有未提交改动。33 个源码/清单/README 文件 SHA-256 与测试前一致。没有运行模型分析或真实生图。

## 证据与复测入口

- summary.json：合并后的 16 个样本指标、预算、结果与源码检查。
- text-results.json、rich-first-results.json、rich-cna-retry-results.json：MCP 结果、通知与导出的安全诊断。
- assets-summary.json：资产尺寸、格式、内容哈希、块引用和错误码，不含原始签名 URL。
- ap-cookie-probe.json、content-probes.json、xinhua-replay.json、dns-results.json：针对性验证。
- 私有测试目录：C:/Users/haige/AppData/Local/Temp/global-news-toolkit-AM4Kji；data/capture-sources 下保留快照 JSON 和真实图片字节，data/state.json 保留编号正文。该目录位于 Temp，清理临时文件前须自行留存。
- 同机复测命令：node C:/Users/haige/AppData/Local/Temp/global-news-toolkit-AM4Kji/benchmark.mjs text 或 rich。重新运行会覆盖该目录对应阶段的结果文件并生成新快照；正式新一轮测试应创建新的隔离目录。
