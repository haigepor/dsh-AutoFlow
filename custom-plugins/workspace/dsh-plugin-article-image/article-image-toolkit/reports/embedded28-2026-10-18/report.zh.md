# 公开 Web Story 与视频封面复测（2026-10-18）

[Observed] 全量重新获取28篇，正文成功保持 21/28；partial 4 → 2，needs-review 19。6篇阅读受限与1篇真实短公告保持原错误。本轮真实网络耗时 558.8 秒，未调用模型或真实生图。

[Observed] 篇内去重的可解码图片资产72 → 97，原72份图片字节全部保留；另有 1 份新发现的 Metrópoles 视频封面被同源跳转策略拒绝。正文、小标题和编辑列表覆盖无遗漏；两个故事子页也分别核对段落、标题、列表和所有编辑图片，未把HTTP 200当作完整性证明。16 篇成功快照的语义哈希不变。变化为4、10、19号新增子页内容或失败封面，21号一处重复播放器标题在本轮DOM中不可见，以及22号一处alt变为空；R7正文事实和原封面、22号的原图及包含Mecânico的图注均保留。

## 四篇重点结果

| # | 来源 | 结果 | 证据与限制 |
|---|---|---|---|
| 4 | www.metropoles.com | partial，图片 2/1（就绪/失败） | [Observed] 公开播放器封面已发现，但声明地址及播放列表所列封面均跨域跳转，被现有策略拒绝；保留原2张照片、公开标题及失败资产。3个 Instagram Reel 和1个报道视频继续提示未获取。 |
| 10 | guia.folha.uol.com.br | needs-review，图片 20/0（就绪/失败） | [Observed] 读取15页 Storifyme；按订阅入口/首页推广组件排除2页，合并13页编辑内容与来源。原6图均保留，新增14份去重子页资产，共20图；子页7个非空段落、12个标题均覆盖，无真实列表。 |
| 19 | www.cnnbrasil.com.br | needs-review，图片 13/0（就绪/失败） | [Observed] 读取11页 AMP Story，转换 AMP-IMG 并保留原始 srcset 候选；排除重复 CNN 标识及 Vector 装饰图。主文档原2图保留，新增11份子页资产，共13图；子页21段、2个标题覆盖，无真实列表。 |
| 21 | record.r7.com | partial，图片 1/0（就绪/失败） | [Observed] 原视频封面960×540保留；VideoObject 简介已出现在现有正文，未重复追加。未发现字幕 track；播放器的一处重复标题标签在本轮渲染中不可见，不属于新增正文遗漏。真实视频继续 partial。 |

[Observed] Guia 的15个 data-slide 连续，完整取到13页编辑内容和2页明确推广；页面原图最大15,521,071字节，全部20份资产合计90,308,857字节。首次尝试保留12MB/64MB原限制时有5份资产失败，调整部署预算后全部获取。另一次页面图库未展开，content-not-ready 正确维持 partial；最终完整复测的图库5张均加载，既有6图字节全部保留。此类网络加载失败仍会显示限制，不会因故事提取成功而掩盖。

[Observed] CNN 的11页 AMP Story 共新增11份去重照片资产，反复出现的CNN logo和Vector装饰按明确来源排除；原文的两张照片保留。两组子页没有真正的HTML列表，类别式内容按原有标题保留，未伪造列表。嵌套编辑列表的保留由独立回归测试覆盖。

[Observed] Metrópoles 原iframe公开HTML HTTP 200；og:image 返回跨域跳转。继续检查其公开脚本声明的播放列表，确认提供320至1920宽度JPEG封面和仅供缩略图的VTT；1920封面实测仍返回跨域跳转。没有跟随跨域跳转、猜测CDN地址或下载视频。R7 VideoObject的简介与正文一致，无需再补重复段落；封面像素与字节保留，页面没有字幕track。真实视频/Instagram Reel没有被标记为已完整获取。

## 28篇逐项结果

| # | 原文 | 结果 | 段/标题/列表项 | 图片就绪/失败 | 分析 |
|---|---|---|---|---|---|
| 1 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/turismo/2026/10/roteiro-de-36-horas-no-lago-de-como-na-italia-destaca-vilarejos-arte-e-gastronomia.shtml) | article-restricted | — | — | [Observed] 可见阅读/订阅限制，保持 article-restricted，不绕过访问限制。 |
| 2 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/turismo/2026/08/taiwan-e-destino-turistico-vibrante-apesar-de-tensoes-com-a-china.shtml) | article-restricted | — | — | [Observed] 可见阅读/订阅限制，保持 article-restricted，不绕过访问限制。 |
| 3 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/turismo/2026/07/resort-oiti-beach-e-base-confortavel-para-conhecer-tutoia-no-maranhao.shtml) | article-restricted | — | — | [Observed] 可见阅读/订阅限制，保持 article-restricted，不绕过访问限制。 |
| 4 | [www.metropoles.com](https://www.metropoles.com/conteudo-especial/orlando-com-bebes-e-criancas) | partial | 24/5/0 | 2/1 | [Observed] 公开播放器封面已发现，但声明地址及播放列表所列封面均跨域跳转，被现有策略拒绝；保留原2张照片、公开标题及失败资产。3个 Instagram Reel 和1个报道视频继续提示未获取。 |
| 5 | [www.correiobraziliense.com.br](https://www.correiobraziliense.com.br/aqui/2026/08/06/7-destinos-na-argentina-para-fugir-da-alta-do-dolar-e-aproveitar/) | needs-review | 2/1/7 | 1/0 | [Observed] 未匹配DOM图片4张均为相关文章推荐缩略图；正文照片与基线相同。 |
| 6 | [www.correiobraziliense.com.br](https://www.correiobraziliense.com.br/aqui/2026/08/06/mallorca-5-passeios-para-fazer-na-ilha-espanhola-paradisiaca/) | needs-review | 13/1/0 | 1/0 | [Observed] 未匹配DOM图片4张均为相关文章推荐缩略图；正文照片与基线相同。 |
| 7 | [www.otempo.com.br](https://www.otempo.com.br/turismo/2026/7/23/temporada-de-aguas-mais-cristalinas-em-bonito-6-passeios-imperdiveis) | needs-review | 16/7/0 | 8/0 | [Observed] 主文档段落、标题与编辑列表覆盖通过，既有原图字节保留；声明图片URL变体仍按未匹配数量供核对。 |
| 8 | [guia.folha.uol.com.br](https://guia.folha.uol.com.br/restaurantes/2026/10/festival-gastronomico-da-folha-tem-curadoria-musical-do-blue-note.shtml) | needs-review | 40/3/0 | 20/0 | [Observed] 主文档段落、标题与编辑列表覆盖通过，既有原图字节保留；声明图片URL变体仍按未匹配数量供核对。 |
| 9 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/comida/2026/10/veja-como-fazer-a-buchimgae-panqueca-coreana-com-receita-de-arthur-paek.shtml) | article-restricted | — | — | [Observed] 可见阅读/订阅限制，保持 article-restricted，不绕过访问限制。 |
| 10 | [guia.folha.uol.com.br](https://guia.folha.uol.com.br/restaurantes/2026/10/saiko-leva-sandos-sanduiches-ao-estilo-japones-a-festival-gastronomico-da-folha.shtml) | needs-review | 28/14/0 | 20/0 | [Observed] 读取15页 Storifyme；按订阅入口/首页推广组件排除2页，合并13页编辑内容与来源。原6图均保留，新增14份去重子页资产，共20图；子页7个非空段落、12个标题均覆盖，无真实列表。 |
| 11 | [g1.globo.com](https://g1.globo.com/sp/vale-do-paraiba-regiao/especial-publicitario/festa-das-flores-e-morangos-de-atibaia/flores-e-morangos/noticia/2026/09/10/festa-em-atibaia-flores-morangos-gastronomia-e-cultura-japonesa-sao-atracoes.ghtml) | needs-review | 19/3/10 | 4/0 | [Observed] 主文档段落、标题与编辑列表覆盖通过，既有原图字节保留；声明图片URL变体仍按未匹配数量供核对。 |
| 12 | [www.gov.br](https://www.gov.br/saude/pt-br/campanhas-da-saude/2026/triplice-viral) | needs-review | 25/1/9 | 3/0 | [Observed] 未匹配DOM图片为 Vaccine Safety Net 品牌SVG；正文文字与既有3张照片保留。 |
| 13 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/sobretudo/carreiras/2026/10/nao-sabe-para-onde-ir-na-carreira-aprenda-a-definir-seus-objetivos.shtml) | article-restricted | — | — | [Observed] 可见阅读/订阅限制，保持 article-restricted，不绕过访问限制。 |
| 14 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/ambiente/2026/10/seca-e-calor-extremos-do-ultimo-el-nino-antecipam-novo-normal-nas-florestas-tropicais.shtml) | article-restricted | — | — | [Observed] 可见阅读/订阅限制，保持 article-restricted，不绕过访问限制。 |
| 15 | [canaltech.com.br](https://canaltech.com.br/entretenimento/crunchyroll-animes-imperdiveis-outubro-2026/) | needs-review | 31/9/8 | 9/0 | [Observed] 主文档段落、标题与编辑列表覆盖通过，既有原图字节保留；声明图片URL变体仍按未匹配数量供核对。 |
| 16 | [www.cultura.sc.gov.br](https://www.cultura.sc.gov.br/programacao/tipo/exposicao/3960-exposicao-pinturas-derivas?date=2026-10-13-00-00) | needs-review | 13/1/1 | 1/0 | [Observed] 主文档段落、标题与编辑列表覆盖通过，既有原图字节保留；声明图片URL变体仍按未匹配数量供核对。 |
| 17 | [www.lance.com.br](https://www.lance.com.br/tenis/thiago-wild-deixa-mais-um-torneio-e-aumenta-duvida-sobre-retorno.html) | needs-review | 10/1/0 | 2/0 | [Observed] 主文档段落、标题与编辑列表覆盖通过，既有原图字节保留；声明图片URL变体仍按未匹配数量供核对。 |
| 18 | [www.gov.br](https://www.gov.br/jbrj/pt-br/assuntos/noticias/semana-nacional-de-ciencia-e-tecnologia-2026-201cciencia-delas-destaca-o-papel-de-mulheres-cientistas) | needs-review | 5/1/0 | 1/0 | [Observed] 主文档段落、标题与编辑列表覆盖通过，既有原图字节保留；声明图片URL变体仍按未匹配数量供核对。 |
| 19 | [www.cnnbrasil.com.br](https://www.cnnbrasil.com.br/auto/quatro-cuidados-para-ter-no-carro-durante-periodo-da-primavera-confira/) | needs-review | 36/6/0 | 13/0 | [Observed] 读取11页 AMP Story，转换 AMP-IMG 并保留原始 srcset 候选；排除重复 CNN 标识及 Vector 装饰图。主文档原2图保留，新增11份子页资产，共13图；子页21段、2个标题覆盖，无真实列表。 |
| 20 | [www.correiobraziliense.com.br](https://www.correiobraziliense.com.br/brasil/2026/09/7510825-viagem-de-carro-5-dicas-para-trafegar-com-seguranca-pelas-rodovias.html) | needs-review | 15/2/3 | 3/0 | [Observed] 主文档段落、标题与编辑列表覆盖通过，既有原图字节保留；声明图片URL变体仍按未匹配数量供核对。 |
| 21 | [record.r7.com](https://record.r7.com/fala-brasil/mulheres-positivas/video/mulheres-positivas-influenciadora-promove-autonomia-feminina-com-dicas-sobre-cuidados-automotivos-26092026/) | partial | 7/2/0 | 1/0 | [Observed] 原视频封面960×540保留；VideoObject 简介已出现在现有正文，未重复追加。未发现字幕 track；播放器的一处重复标题标签在本轮渲染中不可见，不属于新增正文遗漏。真实视频继续 partial。 |
| 22 | [www.estadao.com.br](https://www.estadao.com.br/jornal-do-carro/oito-sinais-de-que-os-freios-do-seu-carro-vao-falhar/) | needs-review | 43/4/3 | 3/0 | [Observed] 三张原图字节与尺寸均不变；第三张alt从Mecânico变为空，图注仍完整保留Mecânico Foto: Layer Up，造成语义哈希变化。正文无遗漏。 |
| 23 | [www.bcb.gov.br](https://www.bcb.gov.br/detalhenoticia/21283/nota) | article-short | — | — | [Observed] 公告正文仍低于最低字数，保留 article-short。 |
| 24 | [www.bcb.gov.br](https://www.bcb.gov.br/detalhenoticia/21276/noticia) | needs-review | 8/0/0 | 0/0 | [Observed] 主文档段落、标题与编辑列表覆盖通过，既有原图字节保留；声明图片URL变体仍按未匹配数量供核对。 |
| 25 | [www.bcb.gov.br](https://www.bcb.gov.br/detalhenoticia/21275/nota) | needs-review | 1/0/0 | 0/0 | [Observed] 主文档段落、标题与编辑列表覆盖通过，既有原图字节保留；声明图片URL变体仍按未匹配数量供核对。 |
| 26 | [www.gov.br](https://www.gov.br/suframa/pt-br/assuntos/noticias/suframa-e-receita-federal-discutem-implementacao-da-reforma-tributaria-na-zona-franca-de-manaus-e-areas-de-livre-comercio) | needs-review | 11/1/0 | 2/0 | [Observed] 未匹配DOM地址为Plone动态裁剪变体；两张既有图片的原始字节与语义哈希不变。 |
| 27 | [www.gov.br](https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/outubro/operacao-inflamavel-ii-da-receita-federal-apura-aproveitamento-indevido-de-creditos-de-pis-pasep-e-cofins-na-revenda-de-oleo-diesel-gasolina-e-etanol) | needs-review | 14/1/0 | 1/0 | [Observed] 未匹配DOM地址为Plone动态裁剪变体；既有图片的原始字节与语义哈希不变。 |
| 28 | [www.gov.br](https://www.gov.br/nfse/pt-br/noticias/comite-gestor-da-nfs-e-se-reune-belo-horizonte-mg-para-homologar-novas-funcionalidades-para-a-reforma-tributaria) | needs-review | 8/1/0 | 2/0 | [Observed] 未匹配DOM地址为Plone动态裁剪变体；两张既有图片的原始字节与语义哈希不变。 |

## 实现、验证与回滚

- DONE：capture-embeds.js 在精确主机和DOM选择器配置下，仅获取一层公开iframe。故事在原位置合并并保留安全来源链接；AMP图片、懒加载原图、行内格式和嵌套列表沿用现有富文本提取与媒体校验。
- DONE：原文和子文档先检查访问声明，再做推广排除与 inactive 页投影；隐藏后代、缺页序、空模板、非允许主机、跨源返回地址和超预算均保留 partial。子页与主文档共用HTML/元素、正文、图片预算和取消生命周期。
- DONE：视频仅补公开封面/简介，保留真实播放器和未获取限制；错误码、origin和完成数量接入既有进度及日志，默认诊断不含原文、完整路径、Cookie或请求头。
- DONE：审计CLI保存私有子页HTML和清单，分别核对主文档/子页，可离线 --review；--timeout-ms 为有界显式总期限。
- DONE：新增10项回归，包含先失败后修复的Web Story、隐藏模板、相对原图、列表顺序、来源/主标题、403/订阅、跨源、累计HTML与数量预算、abort/dispose在飞请求。工具包24文件/368项、父插件15文件/147项测试通过；client构建、插件check、README配对检查通过。
- DONE：Web通过支持的dsh profile重启；实际状态接口HTTP 200、adapterCount=9、browser.available=true、generation.available=false。28条工作台队列可读，日志/Debug可切换，已认证页面控制台错误0。新浏览器上下文无引导链接访问时HTTP 401为预期认证拒绝。

修改文件：article-image-toolkit/src/capture.js、src/capture-embeds.js、test/capture-embeds.test.js、scripts/audit-rich-capture.mjs、README.md/README.zh.md/README.i18n.yaml；父插件src/client/locales/{en,zh}.json及client.js；本报告目录。影响限于显式配置的子页面提取、媒体预算、诊断文案和离线审计，未改页面布局或现有持久化格式。

运行配置只修改capture.adapters、maxImageBytes=24,000,000与maxTotalImageBytes=160,000,000；代理、DoH及模型配置未变。全量采用60秒单请求、120秒渲染、480秒审计行期限、16MB HTML、并发2。大图文章约90MB，会增加下载时间及本地存储。测试写入独立私有目录，不覆盖现有文章库与审核记录；手动验证需重新获取文章。

回滚：本轮改前文件保存在 C:/Users/haige/AppData/Local/Temp/article-embeds-OLxcx0/before，运行配置原件为 C:/Users/haige/AppData/Local/Temp/article-embeds-OLxcx0/cordis.patch.before.yml。只恢复本轮对应文件和capture配置块；新增capture-embeds.js及测试/报告仅为本轮文件。不要Git重置整个插件。范围、编码和业务库不变检查见私有 C:/Users/haige/AppData/Local/Temp/article-embeds-OLxcx0/scope-check.json。

- NEXT：若需要把两篇视频文章也变为完整输入，需补充可公开获取的完整视频文字来源；当前保持2篇partial，6篇受限与1篇短公告仍不自动分析。
