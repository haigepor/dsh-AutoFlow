# 文章抓取提速实施与 3080 验收

日期：2026-10-18，Asia/Shanghai。Observed 表示本轮代码或真实运行证据；Inferred 表示由证据推导的结论。本轮保留既有未提交改动，没有接入真实生图、安装新依赖或修改控制面。

## 结论

Observed：最终判定 **GO（正文、列表、原图和质量状态不退步）**。通过 3080 工作台实际“全选本页 → 处理所选”提交 28 篇，整批墙钟 21分26.758秒 → 12分11.679秒，本轮减少 43.14%。单任务 P50 67.761 → 43.321 秒，P95 183.755 → 107.994 秒，均包括受限和失败任务。20/21 篇原始快照语义哈希完全一致。R7 原始哈希不同，仅少一个经 DOM 确认的播放器标题/频道浮层；其余 142 块及剔除该浮层后的完整语义哈希一致。全部正文和列表保留，98 个文章内原图资产的完整文件 SHA256 一致，R7 的 131 条字幕起止时间和每条文本哈希一致。

Observed：优化前对照有 20 篇本轮新快照，O Tempo #7 超时后保留旧快照；最终要求并获得 21 篇新快照。其余 6 篇访问受限和 1 篇短公告维持原有分类，不把旧快照保留或受限页计成新抓取成功。partial 文章序号为 4、21；视频画面及未取得的嵌入内容仍需人工核对。

Inferred：这些数字支持本批次提速通过，不能证明所有站点或以后每次都加速。仅有一组完整新对照与最终验收，公网、CDN、系统及代理缓存未受控；两轮中断批次可能增加缓存预热。本轮没有把静态、连接复用和网络波动的贡献强行拆成独立百分比。

Observed：最终实际为28篇、29次尝试。第1篇首次运行38.867秒后受限，又出现一次89.357秒重试（仍article-restricted）；触发来源未归因，不将其冒充单次任务。两次开始/结束时间分别记账，P50/P95包含29次尝试，整批墙钟包含额外重试及其资源占用；没有剔除重试换取更快数字。相比28次尝试的对照，最终工作量多一次，这也是比较局限。

## 已实施内容

Observed：在现有富文本内核增加按站点 opt-in 的静态前置通道。只在 canonical 精确匹配、唯一正文容器、唯一且有序的首尾标记、必需结构存在、无未解决动态内容、字节/字符/元素/图片预算和原图校验都通过时发布。静态标签为 static-dom/static-site-verified；未知模板、分页、公开子页、字幕、SPA、未展开内容及不确定图片回退浏览器。访问限制在清理前检查，不能通过噪声剔除隐藏门闸。Correio 仅批准 .entry-content > .content-inner 模板；gov.br 过滤分类标题和已核对的页面工具脚本，保留 #media 主图，不扩大删除范围。

Observed：浏览器使用独立篇级受控连接会话，默认最多 8 个连接池、每来源 4 条连接。每个请求仍重新检查 URL 和公网地址，按 origin 与已验证 IP 集合隔离连接，代理 CONNECT 固定到已验证 IP，Host/SNI 保留发布站域名。普通请求、图片会话默认值和图片字节/像素预算未变。闲置池淘汰同步预留新池，避免并发覆盖；dispose 中止在飞及排队请求并等待连接关闭。0 可关闭渲染连接复用。

Observed：只有 R7 启用 browserResources.deferTypes=[image,font,media]；保留 DOM 图片声明，原图仍由现有下载/候选回退/真实 Chromium 解码流程取得。script、stylesheet、XHR、fetch 继续受控加载；无适配器的站点保留全部资源。录制模式不应用资源延后策略，没有 route.continue 或浏览器直连出口。

Observed：第一完整候选虽然用时 13分4.754秒，仍因 Estadão #22 的 b18 空 alt 判为 NO-GO；原图字节和图注当时并未丢失。独立实测等待懒加载到 120 秒仍不能稳定补全。当前文章 Fusion.globalContent 的 canonical_url、content_elements/image、additional_properties.resizeUrl、alt_text 明确声明原描述“Oficina - Mecânico”。新增默认 [] 的 imageMetadataSources，仅从当前页主执行上下文的配置路径读取自有数据属性，禁止 getter、原始脚本求值和推荐内容递归搜索；匹配现有 DOM 图片身份后只补空 alt，不从图注猜测，不新增图片或改下载地址。扫描/输出超限及精确 URL 冲突拒绝整组；归一化身份冲突保留哨兵，任何冲突候选都阻止该图补写。真实浏览器快照和组合负例覆盖此路径。

Observed：诊断新增已本地化的 static-start/static-complete/static-fallback/resource-deferred/image-metadata-complete；事件只含安全来源、类型、数量和错误码。没有重新设计 UI 样式。没有新增 npm/Python 依赖或自动安装浏览器。

Observed：第二个完整候选虽然正文和图片保留，仍因 Correio #20 同主机另一模板误匹配而判为 NO-GO；其 partial 和 145.467 秒等待没有被归为公网波动。新增 adapter.pathPrefixes 后，Correio 仅匹配 /aqui/，/brasil/ 回到原通用浏览器；静态入口、渲染就绪/资源、最终提取和静态跳转校验共用匹配。主文档跳转后在交付 HTML 前重新选择模板，两向跳转和同站不同模板均有负例及真实 Web 回归。

## 28 篇逐篇对比

Observed：下表单位为秒，单任务耗时从该任务持久化 running 到终态，不含队列等待；整批墙钟另算。块/列表/原图为最终快照数量；“—”表示无快照。两列失败候选完整保留，不能用它们替代最终验收。所有表格均保留网络失败和尾延迟，不按最快样本挑选。

| 序号 | 站点 | 对照秒 | alt 失败候选秒 | 模板失败候选秒 | 最终秒 | 最终路径 | 块/列表/原图 | 最终抓取分类 |
|---:|---|---:|---:|---:|---:|---|---:|---|
| 1 | www1.folha.uol.com.br | 183.545 | 106.272 | 50.808 | 38.867 | browser | — | article-restricted |
| 2 | www1.folha.uol.com.br | 183.755 | 94.091 | 46.836 | 38.412 | browser | — | article-restricted |
| 3 | www1.folha.uol.com.br | 112.387 | 87.429 | 44.460 | 24.105 | browser | — | article-restricted |
| 4 | www.metropoles.com | 94.908 | 98.045 | 52.676 | 22.887 | browser | 38/0/3 | partial |
| 5 | www.correiobraziliense.com.br | 68.684 | 27.689 | 8.393 | 9.990 | static | 5/1/1 | passed |
| 6 | www.correiobraziliense.com.br | 58.171 | 31.203 | 34.149 | 42.310 | static → browser | 15/0/1 | needs-review |
| 7 | www.otempo.com.br | 75.632 | 50.158 | 99.216 | 98.870 | browser | 31/0/8 | needs-review |
| 8 | guia.folha.uol.com.br | 153.706 | 83.796 | 76.985 | 90.138 | browser | 63/0/20 | needs-review |
| 9 | www1.folha.uol.com.br | 83.742 | 32.201 | 61.550 | 27.317 | browser | — | article-restricted |
| 10 | guia.folha.uol.com.br | 322.875 | 143.750 | 203.090 | 182.758 | browser | 72/0/20 | needs-review |
| 11 | g1.globo.com | 82.665 | 41.300 | 55.942 | 54.804 | browser | 27/1/4 | needs-review |
| 12 | www.gov.br | 46.200 | 51.034 | 55.257 | 61.678 | static → browser | 32/3/3 | needs-review |
| 13 | www1.folha.uol.com.br | 61.995 | 52.551 | 49.351 | 45.350 | browser | — | article-restricted |
| 14 | www1.folha.uol.com.br | 67.963 | 45.298 | 42.779 | 35.961 | browser | — | article-restricted |
| 15 | canaltech.com.br | 61.815 | 47.501 | 39.982 | 57.337 | browser | 50/1/9 | needs-review |
| 16 | www.cultura.sc.gov.br | 31.686 | 32.632 | 29.132 | 49.674 | browser | 16/1/1 | needs-review |
| 17 | www.lance.com.br | 18.159 | 28.878 | 23.219 | 34.167 | browser | 13/0/2 | needs-review |
| 18 | www.gov.br | 51.656 | 11.173 | 8.744 | 15.049 | static | 7/0/1 | passed |
| 19 | www.cnnbrasil.com.br | 165.867 | 57.056 | 76.670 | 107.994 | browser | 55/0/13 | needs-review |
| 20 | www.correiobraziliense.com.br | 50.545 | 149.194 | 145.467 | 43.321 | browser | 21/1/3 | needs-review |
| 21 | record.r7.com | 64.992 | 42.191 | 38.167 | 41.658 | browser | 142/0/1 | partial |
| 22 | www.estadao.com.br | 67.502 | 40.139 | 39.274 | 40.068 | browser | 51/1/3 | needs-review |
| 23 | www.bcb.gov.br | 92.983 | 41.901 | 36.326 | 75.345 | browser | — | article-short |
| 24 | www.bcb.gov.br | 81.131 | 30.569 | 38.259 | 44.547 | browser | 8/0/0 | needs-review |
| 25 | www.bcb.gov.br | 67.761 | 25.006 | 31.347 | 40.834 | browser | 1/0/0 | needs-review |
| 26 | www.gov.br | 45.717 | 12.712 | 10.717 | 14.878 | static | 14/0/2 | passed |
| 27 | www.gov.br | 55.397 | 46.089 | 40.435 | 49.604 | static → browser | 16/0/1 | needs-review |
| 28 | www.gov.br | 56.547 | 46.168 | 43.544 | 48.577 | static → browser | 11/0/2 | needs-review |

Observed：最终静态成功序号为 5、18、26；其余配置静态但无法确认完整性的样本均由浏览器继续处理。按行耗时受公网波动影响，个别任务变慢须保留分析，不能因整批更快而忽略。原图数量按文章内去重资产相加，全局内容寻址存储仍可再次去重。

Observed：表中第1篇为首次尝试；额外重试单独记录在final.json.extraAttempts，排队30毫秒、执行89.357秒，未与首次尝试混用时间戳。

## 验收证据

Observed：对应代码位置如下，均为最终冻结代码。

| 行为 | 代码位置 |
|---|---|
| opt-in 静态入口及回退预算 | [capture.js:372](../../src/capture.js#L372)、[capture.js:497](../../src/capture.js#L497) |
| 主机/路径模板选择及跳转后重选 | [capture-adapters.js:4](../../src/capture-adapters.js#L4)、[capture-renderer.js:166](../../src/capture-renderer.js#L166) |
| 模板身份、起止、动态内容及边界检查 | [capture-static.js:16](../../src/capture-static.js#L16) |
| 受控会话、连接隔离及销毁 | [capture-media.js:127](../../src/capture-media.js#L127)、[capture-media.js:141](../../src/capture-media.js#L141) |
| 浏览器独立连接会话与资源延后路由 | [capture-renderer.js:106](../../src/capture-renderer.js#L106)、[capture-renderer.js:129](../../src/capture-renderer.js#L129) |
| 主执行上下文的当前文章元数据 | [capture-image-metadata.js:4](../../src/capture-image-metadata.js#L4)、[capture-renderer.js:293](../../src/capture-renderer.js#L293) |
| 图片描述冲突与现有 DOM 补写 | [capture.js:289](../../src/capture.js#L289)、[declared-images.js:34](../../src/declared-images.js#L34) |

Observed：{"all28FreshAttemptsAccounted":true,"all21FreshSnapshots":true,"orderedBodyBlocksIdentical":true,"listStructuresIdentical":true,"allOriginalBytesIdentical":true,"bodySemanticHashesIdentical":true,"r7All131CuesIdentical":true,"noNewCaptureFailures":true,"noNewPartialStatuses":true,"noModelAnalysis":true}。131 条字幕逐条核对开始/结束时间及文本 SHA256，组合文本哈希为 3f3a4b5a592174465b1d3fc2425c33f7814907177577eb49513771f46511be55；范围 00:00:00.000–00:07:01.000。原图逐文件核对长度及 SHA256，未以缩略图或 MIME 声明代替原图与真实解码。正文比较含强调、链接、嵌套列表、图片说明、图注和署名。

Observed：原始审核保留 #21 orderedBlockLosses/changedBlocks 和 sourceHashUnchanged=false。唯一减少的旧 b138 是 Video.js 的 .vjs-overlay .vjs-title-overlay-wrap，包含 .vjs-title-text__link 当前视频自链接及 .vjs-title-description__link 频道链接，区别于文章 byline。额外关闭全部资源延后策略进行真实受控渲染，核对该浮层 DOM 文本和 canonical 后，删除旧 b138 并同步块号/图片位置，142 块逐字段及完整语义哈希与最终结果一致。131 条字幕、封面及正文链接均保留。没有全局忽略文本或修改产品代码来掩盖差异。该次额外诊断在28篇计时结束后执行，不计入731.679秒批次耗时。最终 #22 原始哈希完全一致；前一模板失败候选的4条 PUBLICIDADE 广告变化另外保留，没有插回广告。

Observed：工具包 32 个文件 524 项测试通过；父插件 17 个文件 157 项通过；Client 构建、插件检查、真实浏览器 Web keyless 快照更新及无更新重放、双语配对和升级说明检查通过。测试先复现静态/生命周期负例、图片元数据及冲突组合、模板范围和跳转失败，再验证修复。完整命令和结果见 checks.json。真实模型调用为 0。

## 计时与局限

Observed：Node v25.2.1、Windows、并发 2，原有代理/Cloudflare DoH、60 秒请求及 120 秒渲染预算保持一致。计时从最早 queued 到最后终态 updatedAt，包含浏览器脚本及等待、公开子页/字幕、富文本抽取、全部原图传输、真实图片解码、校验和原子发布；不含应用启动、模型理解或生图。原图 24 MB/张与 160 MB/篇预算未下调，未降低图片数量、质量或解析范围来换取速度。

Observed：对照服务及浏览器已预热，候选重启服务；未清操作系统/代理缓存。对照期间有轻量编辑和短测试，重型完整检查安排在批次之间；最终冻结批次期间只有轻量只读观察。模型分析临时关闭以固定抓取计时终点，验收后恢复原 provider/model 与分析设置；业务任务可能停在 waiting-config，可在工作台恢复继续分析，不能据此判断正文获取失败。中断的两个批次明确标记为 INVALIDATED，未计入任何完整批次速度统计。

Inferred：后续若承诺稳定收益，应在固定工作负载下至少做三轮交错对照与候选，保留冷/暖条件、每次失败和尾延迟；本轮不把研究报告更早的 874.446 秒旧版本结果当作新基线。受限站点遵守访问限制，不增加登录墙、付费墙或交互验证码绕过。

## 文件、配置和回滚

Observed：本轮代码、测试、locale/编译客户端、README 配对及升级说明的分组用途见 changes.json；逐文件的本轮哈希与越界检查见 scope.json。原有未提交文件以任务开始时字节哈希为对照，未做 reset、clean、提交或无关回滚。运行配置在用户 web profile，只增加已批准的站点/资源/图片描述规则和连接参数，保持原有代理、DoH、模型及预算；未改全局 Codex/AGENTS/Skills。

Observed：可分别移除 adapter.static、移除 adapter.browserResources、设置 rendererConnectionPoolSize=0、设置 imageMetadataSources=[] 回滚对应能力。完整源码回滚使用私有任务目录 before 中的本轮前精确字节，配置使用 cordis.before.yml；只恢复本轮文件，禁止 git reset/clean 覆盖既有改动。业务快照与原图继续保留，不随代码回滚重写索引。旧严格配置读取器须移除新增字段，说明已写入升级文档。

证据文件：[comparison.json](comparison.json)、[baseline.json](baseline.json)、[rejected-candidate.json](rejected-candidate.json)、[template-rejected.json](template-rejected.json)、[final.json](final.json)、[player-ui-delta.json](player-ui-delta.json)、[ad-label-delta.json](ad-label-delta.json)、[measurement.json](measurement.json)、[checks.json](checks.json)、[capture-config.json](capture-config.json)、[changes.json](changes.json)、[scope.json](scope.json)、[runtime.json](runtime.json)。capture-config.json 的代理地址已脱敏，用于审查而非直接运行。没有公开认证引导 URL、Cookie、密钥、完整 HTML 或原图文件。
