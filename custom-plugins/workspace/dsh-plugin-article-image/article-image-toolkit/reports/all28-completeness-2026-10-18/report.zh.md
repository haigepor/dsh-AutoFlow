# 28 篇文章获取与完整性复测（2026-10-18）

[Observed] 采用实际导入文章库的 28 条 URL、代理 `127.0.0.1:7897`、Cloudflare DoH、60 秒请求预算、120 秒渲染预算、并发 2。使用插件与 MCP 共用的 `createCapture` 内核，结果写入私有独立目录，不写入业务文章库，不调用分析模型或生图服务。

## 结果与适用范围

[Observed] 正文获取 19/28 → 21/28；原有 19 篇成功项全部保持成功。最终每篇内去重后累计 79 份图片资产就绪，失败图片 0。首轮失败资产 4 份。完整 28 篇复测耗时 404.2 秒；随后针对 Plone/Arc 原图匹配补测 22、26、27、28 号。

[Observed] 21 篇成功快照的所选正文范围，重新比较已保存 DOM/发布者 articleBody 后，未发现未覆盖的段落或小节标题。失败仍有 6 篇 article-restricted 和 1 篇 article-short。质量分布：{"passed":0,"needs-review":16,"partial":5}；“取得正文”不等于“已证明完整、可直接分析”。

[Observed] 图库等待、原图解码、段落/标题修复通过确定性测试及真实 Chromium 验证。图片数按每篇内去重资产累计；段落数为快照 paragraph 块，可能含源站单独呈现的图注、元信息，不能当成纯编辑段落数量。原图保存页面公开候选的原始字节，不承诺存在但未公开的后台高清文件。

[Inferred] 相同照片的响应式尺寸、裁剪 URL 不能按地址数算成独立漏图。报告保留未匹配数量和来源分类；元数据独有的封面仍需人工核对。R7 的视频流及其他不支持视觉内容没有被标成已获取。

## 逐篇结果

“段/标题/列表项”均为快照块统计；“图片就绪/失败”按资产计。所有失败保留原错误语义。

| # | 来源与文章 | 首轮 → 最终 | 段 / 标题 / 列表项 | 图片就绪 / 失败 | 原因与处理 |
|---|---|---|---|---|---|
| 1 | [Folha：科莫湖行程](https://www1.folha.uol.com.br/turismo/2026/10/roteiro-de-36-horas-no-lago-de-como-na-italia-destaca-vilarejos-arte-e-gastronomia.shtml) | article-restricted → article-restricted | — | — | [Observed] 可见阅读额度限制及订阅声明，保持 article-restricted；需可访问的完整来源或人工补正文。 |
| 2 | [Folha：台湾旅游](https://www1.folha.uol.com.br/turismo/2026/08/taiwan-e-destino-turistico-vibrante-apesar-de-tensoes-com-a-china.shtml) | article-restricted → article-restricted | — | — | [Observed] 同上，访问限制不因 HTML 中有摘要或结构化文本而解除。 |
| 3 | [Folha：Oiti Beach](https://www1.folha.uol.com.br/turismo/2026/07/resort-oiti-beach-e-base-confortavel-para-conhecer-tutoia-no-maranhao.shtml) | article-restricted → article-restricted | — | — | [Observed] 同上，未绕过阅读额度。 |
| 4 | [Metrópoles：奥兰多亲子游](https://www.metropoles.com/conteudo-especial/orlando-com-bebes-e-criancas) | 成功 → 成功 | 23 / 5 / 0 | 2 / 0 | [Observed] 所选范围内段落/标题均覆盖，2 张图均解码；Instagram 嵌入仍属不支持内容，质量保持 partial。 |
| 5 | [Correio：阿根廷七处目的地](https://www.correiobraziliense.com.br/aqui/2026/08/06/7-destinos-na-argentina-para-fugir-da-alta-do-dolar-e-aproveitar/) | 成功 → 成功 | 2 / 1 / 7 | 1 / 0 | [Observed] 修复 Readability 误删相似小节标题；保留 7 个有序列表项和主图。DOM 中额外缩略图来自相关推荐，不属于正文。 |
| 6 | [Correio：Mallorca 五处行程](https://www.correiobraziliense.com.br/aqui/2026/08/06/mallorca-5-passeios-para-fazer-na-ilha-espanhola-paradisiaca/) | 成功 → 成功 | 13 / 1 / 0 | 1 / 0 | [Observed] 13 个段落块与主图保留；直/弯引号差异只在审计比较中统一。额外 DOM 缩略图为推荐卡片。 |
| 7 | [O Tempo：Bonito 六处行程](https://www.otempo.com.br/turismo/2026/7/23/temporada-de-aguas-mais-cristalinas-em-bonito-6-passeios-imperdiveis) | article-resource-limit → 成功 | 16 / 7 / 0 | 8 / 0 | [Observed] 主响应约 8.66 MB 超过原 8 MB 预算；显式配置 16 MB，去除重复 currentSrc 和执行状态。保留 7 张内联照片与 1 张主图、6 个目的地小节。[Inferred] 声明中另两个尺寸地址是同一主图变体。 |
| 8 | [Guia Folha：美食节/Blue Note](https://guia.folha.uol.com.br/restaurantes/2026/10/festival-gastronomico-da-folha-tem-curadoria-musical-do-blue-note.shtml) | 成功 → 成功 | 42 / 3 / 0 | 20 / 0 | [Observed] 滚动后等待图库加载；获得主图 1 张、Tony Gordon 图库 15 张、André Frateschi 图库 4 张。图库标题/图注保留；修复明示 Advertisement 的广告 iframe 被误当作不支持正文视觉内容，质量改为 needs-review。 |
| 9 | [Folha：松饼](https://www1.folha.uol.com.br/comida/2026/10/veja-como-fazer-a-buchimgae-panqueca-coreana-com-receita-de-arthur-paek.shtml) | article-restricted → article-restricted | — | — | [Observed] 订阅/阅读限制，保持 article-restricted。 |
| 10 | [Guia Folha：Saiko 日式三明治](https://guia.folha.uol.com.br/restaurantes/2026/10/saiko-leva-sandos-sanduiches-ao-estilo-japones-a-festival-gastronomico-da-folha.shtml) | 成功 → 成功 | 21 / 2 / 0 | 6 / 0 | [Observed] 解决异步图库尚在 Carregando 时提前结束的问题；5 张图库照片及 1 张主图均取得。首轮另含头像与推荐图，因此资产数 10→6 不等于少取正文照片。图库视觉组件仍保守标 partial。 |
| 11 | [G1：花卉节](https://g1.globo.com/sp/vale-do-paraiba-regiao/especial-publicitario/festa-das-flores-e-morangos-de-atibaia/flores-e-morangos/noticia/2026/09/10/festa-em-atibaia-flores-morangos-gastronomia-e-cultura-japonesa-sao-atracoes.ghtml) | 成功 → 成功 | 19 / 3 / 10 | 4 / 0 | [Observed] 正文、10 个列表项及 4 张图均取得；不把广告网络错误当成正文失败。 |
| 12 | [Gov Saúde：三联疫苗](https://www.gov.br/saude/pt-br/campanhas-da-saude/2026/triplice-viral) | 成功 → 成功 | 25 / 1 / 9 | 3 / 0 | [Observed] 剔除页脚 VSN SVG，原 1 个失败资产消失；保留 3 个可解码视觉资产（含机构标志）。审计未匹配 SVG 是被剔除的页脚标志。 |
| 13 | [Folha：职业](https://www1.folha.uol.com.br/sobretudo/carreiras/2026/10/nao-sabe-para-onde-ir-na-carreira-aprenda-a-definir-seus-objetivos.shtml) | article-restricted → article-restricted | — | — | [Observed] 阅读限制，保持 article-restricted。 |
| 14 | [Folha：环境](https://www1.folha.uol.com.br/ambiente/2026/10/seca-e-calor-extremos-do-ultimo-el-nino-antecipam-novo-normal-nas-florestas-tropicais.shtml) | article-restricted → article-restricted | — | — | [Observed] 阅读限制，保持 article-restricted。 |
| 15 | [Canaltech：八部动画](https://canaltech.com.br/entretenimento/crunchyroll-animes-imperdiveis-outubro-2026/) | 成功 → 成功 | 31 / 9 / 8 | 9 / 0 | [Observed] 配置正文范围并剔除 WhatsApp 品牌推广；主图和 8 个视频缩略图均取得，8 项列表完整。[Inferred] 另 4 个声明地址是主图响应式变体。 |
| 16 | [Cultura SC：展览](https://www.cultura.sc.gov.br/programacao/tipo/exposicao/3960-exposicao-pinturas-derivas?date=2026-10-13-00-00) | 成功 → 成功 | 13 / 1 / 1 | 1 / 0 | [Observed] 正文、列表项与 1 张图均取得。 |
| 17 | [Lance：Thiago Wild](https://www.lance.com.br/tenis/thiago-wild-deixa-mais-um-torneio-e-aumenta-duvida-sobre-retorno.html) | 成功 → 成功 | 10 / 1 / 0 | 2 / 0 | [Observed] 收窄正文并剔除赛事推荐，恢复主图；2 张正文图就绪。[Inferred] 另两个声明地址是同一主图的裁剪尺寸。 |
| 18 | [Gov JBRJ：女性科学家](https://www.gov.br/jbrj/pt-br/assuntos/noticias/semana-nacional-de-ciencia-e-tecnologia-2026-201cciencia-delas-destaca-o-papel-de-mulheres-cientistas) | 成功 → 成功 | 5 / 1 / 0 | 1 / 0 | [Observed] 保留源站完整正文和海报；外层 p/内层块带来的排版空白只在审计时统一，不是缺段。 |
| 19 | [CNN：春季汽车养护](https://www.cnnbrasil.com.br/auto/quatro-cuidados-para-ter-no-carro-durante-periodo-da-primavera-confira/) | 成功 → 成功 | 14 / 4 / 0 | 2 / 0 | [Observed] 剔除推荐模块、关注 CTA；2 张图就绪。[Inferred] 未匹配的两个声明地址属于同一主图尺寸。部分视觉标记仍使质量为 partial。 |
| 20 | [Correio：公路驾驶五条建议](https://www.correiobraziliense.com.br/brasil/2026/09/7510825-viagem-de-carro-5-dicas-para-trafegar-com-seguranca-pelas-rodovias.html) | 成功 → 成功 | 16 / 3 / 13 | 10 / 0 | [Observed] 5 条养护建议、正文图片均保留；源站还包含推荐列表，快照列表项总数不等于建议条数。引号/脚本噪声造成的比较误报已校正；视觉内容仍需核对。 |
| 21 | [R7：女性汽车养护](https://record.r7.com/fala-brasil/mulheres-positivas/video/mulheres-positivas-influenciadora-promove-autonomia-feminina-com-dicas-sobre-cuidados-automotivos-26092026/) | 成功 → 成功 | 8 / 2 / 6 | 1 / 0 | [Observed] 正文段落全部覆盖，取得视频封面；移除推荐缩略图和 R7 品牌 SVG。原文审计剩余的 5 个未匹配 LI 为分享/无障碍控件，快照中 6 个 LI 也含播放器界面项，不能视作编辑列表。视频流未获取，保持 partial。 |
| 22 | [Estadão：制动故障八种征兆](https://www.estadao.com.br/jornal-do-carro/oito-sinais-de-que-os-freios-do-seu-carro-vao-falhar/) | article-short → 成功 | 43 / 4 / 3 | 3 / 0 | [Observed] 修复先选到含短段落的商品 article 卡片的问题；正文与 3 张纵向配图成功。额外封面 XRF4JL…只在元数据中出现，渲染 DOM 无匹配图片，保留人工核对；不是自动补入的正文原图。 |
| 23 | [BCB：Poupança 短公告](https://www.bcb.gov.br/detalhenoticia/21283/nota) | article-short → article-short | — | — | [Observed] 源站正文为单段跳转公告，短于现有 minArticleChars=100；保持 article-short，不降低阈值或拼接导航。 |
| 24 | [BCB：Pix/TIPS](https://www.bcb.gov.br/detalhenoticia/21276/noticia) | 成功 → 成功 | 8 / 0 / 0 | 0 / 0 | [Observed] 自定义 promise 包裹 div 段落曾被压成 1 段；修复后为 8 段，保留链接，尾段校验通过。 |
| 25 | [BCB：货币信贷公告](https://www.bcb.gov.br/detalhenoticia/21275/nota) | 成功 → 成功 | 1 / 0 / 0 | 0 / 0 | [Observed] 原有单段公告保持成功，源站无正文图片。 |
| 26 | [Gov Suframa：税改会议](https://www.gov.br/suframa/pt-br/assuntos/noticias/suframa-e-receita-federal-discutem-implementacao-da-reforma-tributaria-na-zona-franca-de-manaus-e-areas-de-livre-comercio) | 成功 → 成功 | 11 / 1 / 0 | 2 / 0 | [Observed] Plone /@@images/ 缩放图匹配到明确声明的原文件，主图 768×509→1157×768；第二张公开图片保留 663×440。正文均覆盖。 |
| 27 | [Gov Receita：Inflamável II](https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/outubro/operacao-inflamavel-ii-da-receita-federal-apura-aproveitamento-indevido-de-creditos-de-pis-pasep-e-cofins-na-revenda-de-oleo-diesel-gasolina-e-etanol) | 成功 → 成功 | 14 / 1 / 0 | 1 / 0 | [Observed] 已声明原图 768×276→1500×540，正文均覆盖。该图为源站公开的选举期横幅，不替换为臆造新闻图片。 |
| 28 | [Gov NFS-e：功能验收](https://www.gov.br/nfse/pt-br/noticias/comite-gestor-da-nfs-e-se-reune-belo-horizonte-mg-para-homologar-novas-funcionalidades-para-a-reforma-tributaria) | 成功 → 成功 | 8 / 1 / 0 | 2 / 0 | [Observed] 已声明原图 768×276→1728×623，另 1581×417 正文图保留，正文均覆盖。 |

## 修复与证据

- [capture.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture.js)：保护相似小节标题、自定义块级包装器分段、商品卡片回退、正文组件排除及尾段校验。

- [capture-renderer.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-renderer.js)：保留访问标记/JSON-LD 的有界 DOM 投影、避免重复内联 src、滚动后等待 pendingSelector，总预算超时仍报 content-not-ready。

- [capture-media.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-media.js) 与 [declared-images.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/declared-images.js)：内联栅格图真实解码及预算校验；精确公开 srcset、Cloudflare/Plone 缩放、Arc 尺寸签名匹配。网络请求使用原始公开声明 URL，保留未知身份参数；普通 URL 的鉴权参数不被归并。

- [workbench.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/src/client/workbench.js) 与 [workflow-panels.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/src/client/workflow-panels.js)：已加载内容上方不再显示“暂时无法读取任务，请重试”；首次加载失败仍提供重试，Debug 只保留有界错误码，任意错误文本不会泄露到诊断。

- [测试与审计入口](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/scripts/audit-rich-capture.mjs)：保存逐篇 DOM、快照、原始资产、阶段事件及覆盖检查；--review 可离线复核既有结果。测试文件、双语 README、配对记录及 client.js 同步更新。完整修改清单以本轮私有 scope-check.json 为准。

## 验证

- DONE：`pnpm --filter article-image-toolkit test`，23 文件 / 346 项通过，包含真实 Chromium 图库就绪/超时、DOM 预算、内联格式/像素/字节预算、源 ID/鉴权参数保护。

- DONE：`pnpm --filter dsh-plugin-article-image test`，15 文件 / 147 项通过。

- DONE：`pnpm --filter dsh-plugin-article-image build:client` 与 `pnpm --filter dsh-plugin-article-image check` 通过。

- DONE：浏览器模拟读取 503 后，28 条队列仍可见，目标红条不存在，Debug 记录 clientReadError=article-network；恢复读取后错误码清空。首次加载失败与敏感错误文本的恢复分支有回归测试。

- DONE：公开 URL、公网 IP 固定、同源跳转、独立匿名会话和访问限制检查继续执行；不绕过登录、订阅或交互验证码。

- BLOCKED：6 篇受限文章的全文需要可访问完整来源或人工补充；1 篇公告的正文确实过短。

- NEXT：人工复核标为 partial/needs-review 的来源范围、图库视觉组件、R7 视频及 Estadão 元数据独有封面，再执行后续文章理解。

## 部署、数据与回滚

[Observed] 当前 Web 抓取配置新增明确的站点适配及图库等待，HTML 字节/字符预算显式设为 16,000,000；原有 BCB 适配、代理、DoH、模型配置保留。只修改 article-image 行的 capture 字段。Web 通过 dsh web profile 启动，实际工作台 http://127.0.0.1:3080/ 可读取 28 条现有文章。

[Observed] 网络回归输出完全隔离。浏览器现场验证期间首篇另产生一次获取尝试，最终仍为 article-restricted；仅 revision/error/run 历史变化，已有正文、快照、方案等内容不被测试结果覆盖，其余文章保留。

[Observed] 本轮前源文件副本：[before](C:/Users/haige/AppData/Local/Temp/article-image-all28-5ZoME9/before)；profile 原件：[cordis.patch.before.yml](C:/Users/haige/AppData/Local/Temp/article-image-all28-5ZoME9/cordis.patch.before.yml)。回滚只复制本轮对应文件，不用 Git 恢复整个插件，以保留此前未提交实现。

[Observed] 原始网页、图片字节、运行日志及完整配置留在私有临时目录；仓库报告仅保留统计、公开文章链接和无凭据元数据。没有新增运行时、浏览器安装、模型或生图依赖。
