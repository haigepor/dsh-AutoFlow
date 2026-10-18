# 全球新闻站点修复与复测报告

日期：2026-10-18（Asia/Shanghai）。使用上一轮相同的 16 个公开文章 URL，没有换链接、关闭公网策略或尝试登录/付费/交互式验证码。没有接入真实生图、模型分析、新抓取 provider 或新增依赖。

## 结论

Observed：正文仍为 **7/16**，原先 7 篇成功正文的 sourceHash 与段落数全部一致；富文本快照从 **3/16 增至 6/16**。原先 CBS、新华社、NPR 三份富文本的正文去空白后全部一致，CBS 的 6 张大图与 NPR 的 1 张缩略图的字节哈希全部保留。回归检查 PASS。

Observed：新华社从 1 段恢复为 38 段，富文本耗时约 121.5 → 5.1 秒；AP 从 article-access 恢复为 18 段，日志记录匿名会话重试后 HTTP 200。AP 富文本覆盖上一轮编号正文的 16/16 个段落。

返回快照中的 2 份为 needs-review、4 份为 partial，没有 passed；本轮不能宣称任意站点的全文和所有原图都已经完整可用。France 24 的 3 张图片属于新增成功资产；NPR 原有 3 个图片失败仍保留，没有用缩略图冒充原图。

## 修改与原因

1. [嵌套块遍历](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture.js:188)保留 Readability 在外层 p 中形成的段落边界，并保留多段引用的行内强调及图片相对顺序。[非语义正文就绪检测](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-renderer.js:20)允许段落容器触发就绪，避免没有 article/main 的新华社页面等待完整渲染预算；这仍是就绪启发式，不是完整性认证。
2. [共享匿名 jar](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/service.js:48)经 [富文本服务构造](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-service.js:46)传入内核。[隔离浏览器会话](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-renderer.js:102)按主机、路径、Secure、HttpOnly 和过期规则种入 Cookie；响应保留多个 Set-Cookie 头，allHeaders() 取得浏览器实际 Cookie。只有主文档 401/403 下发新的适用 Cookie 时重试一次，相同 Cookie、重复拒绝、404、429 与 5xx 不继续重试。默认诊断没有 Cookie 值。
3. AP 在 HTTP 200 后暴露出第二个问题：唯一 article 元素是评论组件。[正文回退](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture.js:211)仅在默认选中的 main 内 article 无 p 且正文过短时重跑 Readability；显式适配器选择器及有段落的短文章不扩大范围。AP 当前没有捕获原图，仍需人工核对。
4. [主文档错误透传](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-renderer.js:176)保留安全的传输错误码；子资源错误不能替换主文档结果。富文本提取在非 2xx 状态下立即返回原 HTTP 决定；只录制网络而不抽取正文的模式仍能保存拒绝响应。

## 逐站前后对照

每站只测同一篇文章，不能外推为整站支持率。图片列为成功/失败资产数，包含缩略图；耗时为单次实测，不是中位数基准。CNN 为官方节目实录，DW 为公开 AMP 页面。

| 站点 | 正文：前 → 后 | 富文本：前 → 后 | 新质量 | 新图片成功/失败 | 富文本耗时秒：前 → 后 |
|---|---|---|---|---|---|
| [CBS News](https://www.cbsnews.com/news/artemis-ii-mission-astronauts-still-awed-moonshot/) | 45 段 → 45 段 | 38 段 → 38 段 | partial | 6/0 | 105.2 → 86.4 |
| [新华社](https://www.news.cn/tech/20260129/c14ec2642dec4be7942f807dc586e1e9/c.html) | 38 段 → 38 段 | 1 段 → 38 段 | needs-review | 0/0 | 121.5 → 5.1 |
| [Associated Press](https://apnews.com/article/dadb5f9499fa9b52200baada0fdf1f15) | 16 段 → 16 段 | article-access → 18 段 | needs-review | 0/0 | 6.4 → 38.5 |
| [France 24](https://www.france24.com/en/france/20260818-sophie-adenot-set-to-become-first-french-female-astronaut-to-venture-outside-iss) | 20 段 → 20 段 | article-render → 30 段 | partial | 3/0 | 60.1 → 38.5 |
| [CNA](https://www.channelnewsasia.com/world/nasa-artemis-ii-launch-moon-us-6032266) | article-network → article-network | article-render → article-network | — | — | 22.5 → 21.8 |
| [ABC Australia](https://www.abc.net.au/news/2026-03-29/australia-support-nasa-artemis-moon-mission/106508360) | article-url-blocked → article-network | article-render → article-network | — | — | 21.7 → 21.8 |
| [Al Jazeera](https://www.aljazeera.com/news/2026/4/1/nasas-artemis-ii-lifts-off-to-the-moon) | article-url-blocked → article-network | article-render → article-network | — | — | 21.7 → 21.9 |
| [DW](https://amp.dw.com/de/artemis-crew-kehrt-nach-mondumrundung-zur-erde-zurueck-orion-trump-carney/a-76746113) | article-network → article-network | article-render → article-network | — | — | 21.7 → 3.4 |
| [EL PAÍS](https://elpais.com/ciencia/2026-03-24/la-nasa-revela-sus-planes-para-crear-la-primera-colonia-humana-en-la-luna.html) | article-url-blocked → article-network | article-render → article-network | — | — | 21.7 → 21.8 |
| [Folha de S.Paulo](https://www1.folha.uol.com.br/turismo/2026/10/roteiro-de-36-horas-no-lago-de-como-na-italia-destaca-vilarejos-arte-e-gastronomia.shtml) | 59 段 → 59 段 | article-restricted → article-restricted | — | — | 23.7 → 28.4 |
| [News24](https://www.news24.com/life/passengers-and-the-real-life-science-of-deep-space-travel-20161222) | article-network → article-network | article-render → article-network | — | — | 21.7 → 21.8 |
| [South China Morning Post](https://www.scmp.com/news/world/united-states-canada/article/3346456/nasa-clears-artemis-moon-rocket-april-launch-4-astronauts) | article-network → article-url-blocked | article-render → article-network | — | — | 21.6 → 21.8 |
| [NPR](https://www.npr.org/2025/06/06/nx-s1-5424751/private-lunar-lander-from-japan-crashes-into-moon-in-failed-mission) | 28 段 → 28 段 | 33 段 → 33 段 | partial | 1/3 | 32.6 → 52.9 |
| [The Guardian](https://www.theguardian.com/science/2024/may/01/astronauts-could-run-round-wall-of-death-to-keep-fit-on-moon-say-scientists) | article-network → article-network | article-render → article-network | — | — | 21.7 → 21.8 |
| [BBC News](https://www.bbc.co.uk/news/articles/clyrdkxvmmpo) | article-url-blocked → article-network | article-render → article-network | — | — | 22.5 → 21.8 |
| [CNN](https://transcripts.cnn.com/show/se/date/2024-04-08/segment/04) | 354 段 → 354 段 | article-render → 354 段 | partial | 0/0 | 60.1 → 15.0 |

9 个最终网络失败已直接显示为 article-network，Folha 仍返回 article-restricted。文本路径与富文本路径发生于不同进程/时间，DNS 答案可不同；SCMP 的 article-url-blocked 与 article-network 差异不能据此归因于代码退步。没有放宽 SSRF、同源跳转或 DNS 地址固定策略。France 24 与 CNN 本轮恢复获取，但单次网络条件有变化，不能把全部改善归因于 Cookie 修复。

## 验证与证据

- 工具包完整测试：22 文件、296 测试通过，基线为 279 测试。覆盖嵌套段落、引用、评论组件、真实 Chromium 匿名重试、HttpOnly/路径隔离、过期删除、重复拒绝、主文档错误与子资源失败、取消清理、拒绝响应录制及 MCP 错误诊断快照。
- 上层插件定向回归：workflow-v2、analysis-contracts、native-tools 共 28 测试通过；未修改上层插件源码、UI、配置或依赖。
- MCP 实测：最终版本对原 16 URL 分别执行编号正文与富文本调用，共 32 次，均导出分页诊断；18 个工具可用，generation.available 为 false。每条链路并发 2、请求 60 秒、渲染 120 秒、单调用 180 秒；部分重叠时总并发最多 4。缓存关闭、全新隔离数据目录。
- 成功富文本全部通过 MCP 分页读回、持久化快照比对及 sourceHash 校验；所有就绪图片再次核对长度和 SHA-256。regression-checks.json 保存 7 篇正文、3 份既有快照与 7 张既有图片的保留证据。
- node --check、严格 UTF-8/BOM/末尾换行、相对本轮前备份的 diff --check 通过；中英文 README 配对校验通过。最终 MCP 测试期间 27 个源模块哈希未变。

验证曾暴露已有 stdio 测试的 SDK v2 调度竞态：同一批数据中的结果会在异步进度派发前移除回调。该测试改为核验真实线上帧，仍严格要求 queued、rendering、completed 三条通知及诊断终态；客户端回调收到的进度也必须来自这些帧。没有修改 SDK 或放宽服务端终止通知要求。应用消费者应以工具结果和可查询的终止诊断确认完成，不能只等待最后一次进度回调。

## 范围、回滚与复测

本轮只修改 4 个生产模块、4 个测试文件和 README 中英文及其配对记录，共 11 个现有文件；具体清单和前后哈希见 change-manifest.json。开始时记录的 196 个既有变动文件中，授权范围外文件字节保持不变。未执行 git reset、stash、restore、提交或删除既有改动。

本轮前逐文件备份位于 C:/Users/haige/AppData/Local/Temp/news-capture-fixes-pYDVMF/before。只需回滚本轮时，应逐文件对比备份恢复相应修改，不能用仓库 HEAD 覆盖原有未提交工作。备份、完整正文、源 HTML 和图片字节位于 Temp，清理前需另行留存；报告仅导出指标、公开文章 URL 和脱敏诊断。

最终复测私有目录：C:/Users/haige/AppData/Local/Temp/news-capture-fixes-pYDVMF/final-run；数据目录：C:/Users/haige/AppData/Local/Temp/news-capture-fixes-pYDVMF/final-run/data。同机命令为 node benchmark.mjs text 与 node benchmark.mjs rich；执行前应创建新的隔离目录与 run.json，避免覆盖本轮检查点。探索首轮保留在 C:/Users/haige/AppData/Local/Temp/news-capture-fixes-pYDVMF/after-run，其中 AP 的 article-short 是修复评论组件回退前的结果，不参与最终统计。MCP 进程均已关闭，diagnosticId 仅用于关联导出的 JSON，不能跨新进程查询。

## 剩余限制与下一步

修复及这批样本的非退步验证均为 DONE。全球网络可达性、NPR 原图 403、AP 的原图覆盖与正文质量人工核对为 NEXT；不能把本轮 6 份快照当作 6 份完整素材。已有 Web/Host 进程若在修复前启动，需要重新加载插件或重启后才会导入新的 ESM 模块；本轮运行证据来自全新 MCP 进程，不声称已热替换正在运行的工作台。
