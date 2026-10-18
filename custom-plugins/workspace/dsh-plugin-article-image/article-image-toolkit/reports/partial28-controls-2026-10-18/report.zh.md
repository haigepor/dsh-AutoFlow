# 28 篇正文控件误判与 partial 复测（2026-10-18）

[Observed] 原 21 篇正文成功项保持成功；本轮 21/28 成功，partial 5 → 4，needs-review 17。6 篇阅读受限、1 篇真实短公告保持原错误。未把全部 partial 宣称为已修复。完整网络回归耗时 412.4 秒。

[Observed] 主文档取得 72 份篇内去重图片资产，失败 0；上轮 79 份减少的 7 份为第 20 篇推荐缩略图 6 张与分享二维码 1 张。16 篇成功快照与上轮语义哈希相同，变化项须结合下表核对。主文档未发现未覆盖的段落、标题或编辑列表；这一检查不覆盖尚未读取的 iframe/视频内部内容。

[Observed] 语义哈希变化的 5 篇为：8、10 号仅去掉空白块；20 号去掉推荐、分享控件；21 号去掉分享列表；22 号仅一处 alt 从空值变为 Mecânico，3 张图片原始字节完全相同。真实段落与编辑列表未因这些变化丢失。

## 剩余 5 篇的逐项结论

| # | 来源 | 本轮状态 | 原因与处理 |
|---|---|---|---|
| 4 | www.metropoles.com | partial | [Observed] 3 个 Instagram Reel 与 1 个 JWPlayer 报道视频；2 张主文档原图就绪，所选正文段落/标题均覆盖。真实嵌入仍未完整获取，保持 partial。 |
| 10 | guia.folha.uol.com.br | partial | [Observed] 6 张主文档照片就绪。iframe 实测 HTTP 200，包含“圣保罗最佳餐厅获奖者”独立内容及小节标题；不是广告，保持 partial，未把子页面图片算作已获取。 |
| 19 | www.cnnbrasil.com.br | partial | [Observed] 清除全屏按钮图标；2 张主文档照片就绪。Web Story 实测 HTTP 200，有 11 个 amp-story-page；其正文与图片未合并，保持 partial。 |
| 20 | www.correiobraziliense.com.br | needs-review | [Observed] 5 条驾驶建议及 3 张主文档照片保留；移除 Saiba Mais 推荐区的 6 张缩略图和分享区 1 张二维码。图注、放大/轮播 SVG 不再误判；partial → needs-review。 |
| 21 | record.r7.com | partial | [Observed] 去掉分享/播放器控件和广告播放器；Google News 等控件 LI 不再充当编辑列表。正文与视频封面保留，真实视频仍未获取，保持 partial。 |

[Observed] 两个 Web Story 子页面均通过本工具包的公开地址固定传输单独读取，确认其编辑内容存在；没有将网页主题不同、iframe 标签或播放器外壳直接当作广告。Instagram 登录、订阅及交互验证码未被绕过。

[Observed] 首轮完整网络回归中，Canaltech 的 CLT_VIDEO 位动态注入带 Notsy 映射属性的播放器，包含 Advertisement / Ad loading 和推广封面。本轮只在 canaltech-body-v1 的 excludeSelector 中排除此已确认广告位；同供应商也可承载编辑视频（[供应商官方说明](https://pt.linkedin.com/posts/membrana-latam_a-maioria-dos-times-de-conte%C3%BAdo-trata-artigo-activity-7473800782530678785-xteZ)），因此没有全局按供应商名删除播放器。真实同供应商采访视频的封面和正文有负向保护测试。

[Observed] 当前 OpenSpec 的 design.md 规定视频/音频不是本期完整提取对象，含独有信息时提示限制；source-capture spec 要求已知缺失继续阻止自动分析。因此 4 篇真实嵌入内容仍为 partial。要消除这些 partial，需要对子页面实现带页数/图片/顺序校验的专用适配，或提供经人工确认的完整来源；不能只改质量状态。

## 28 篇逐篇结果

图片仅统计主文档与公开 poster，不含尚未读取的子页面图片；列表项包含真正的嵌套列表。

| # | 原文 | 状态 | 段 / 标题 / 列表项 | 图片就绪 / 失败 | 说明 |
|---|---|---|---|---|---|
| 1 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/turismo/2026/10/roteiro-de-36-horas-no-lago-de-como-na-italia-destaca-vilarejos-arte-e-gastronomia.shtml) | article-restricted | — | — | [Observed] 可见订阅/阅读限制，保留 article-restricted；未绕过访问限制。 |
| 2 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/turismo/2026/08/taiwan-e-destino-turistico-vibrante-apesar-de-tensoes-com-a-china.shtml) | article-restricted | — | — | [Observed] 可见订阅/阅读限制，保留 article-restricted；未绕过访问限制。 |
| 3 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/turismo/2026/07/resort-oiti-beach-e-base-confortavel-para-conhecer-tutoia-no-maranhao.shtml) | article-restricted | — | — | [Observed] 可见订阅/阅读限制，保留 article-restricted；未绕过访问限制。 |
| 4 | [www.metropoles.com](https://www.metropoles.com/conteudo-especial/orlando-com-bebes-e-criancas) | partial | 23 / 5 / 0 | 2 / 0 | [Observed] 3 个 Instagram Reel 与 1 个 JWPlayer 报道视频；2 张主文档原图就绪，所选正文段落/标题均覆盖。真实嵌入仍未完整获取，保持 partial。 |
| 5 | [www.correiobraziliense.com.br](https://www.correiobraziliense.com.br/aqui/2026/08/06/7-destinos-na-argentina-para-fugir-da-alta-do-dolar-e-aproveitar/) | needs-review | 2 / 1 / 7 | 1 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 6 | [www.correiobraziliense.com.br](https://www.correiobraziliense.com.br/aqui/2026/08/06/mallorca-5-passeios-para-fazer-na-ilha-espanhola-paradisiaca/) | needs-review | 13 / 1 / 0 | 1 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 7 | [www.otempo.com.br](https://www.otempo.com.br/turismo/2026/7/23/temporada-de-aguas-mais-cristalinas-em-bonito-6-passeios-imperdiveis) | needs-review | 16 / 7 / 0 | 8 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 8 | [guia.folha.uol.com.br](https://guia.folha.uol.com.br/restaurantes/2026/10/festival-gastronomico-da-folha-tem-curadoria-musical-do-blue-note.shtml) | needs-review | 40 / 3 / 0 | 20 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 9 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/comida/2026/10/veja-como-fazer-a-buchimgae-panqueca-coreana-com-receita-de-arthur-paek.shtml) | article-restricted | — | — | [Observed] 可见订阅/阅读限制，保留 article-restricted；未绕过访问限制。 |
| 10 | [guia.folha.uol.com.br](https://guia.folha.uol.com.br/restaurantes/2026/10/saiko-leva-sandos-sanduiches-ao-estilo-japones-a-festival-gastronomico-da-folha.shtml) | partial | 20 / 2 / 0 | 6 / 0 | [Observed] 6 张主文档照片就绪。iframe 实测 HTTP 200，包含“圣保罗最佳餐厅获奖者”独立内容及小节标题；不是广告，保持 partial，未把子页面图片算作已获取。 |
| 11 | [g1.globo.com](https://g1.globo.com/sp/vale-do-paraiba-regiao/especial-publicitario/festa-das-flores-e-morangos-de-atibaia/flores-e-morangos/noticia/2026/09/10/festa-em-atibaia-flores-morangos-gastronomia-e-cultura-japonesa-sao-atracoes.ghtml) | needs-review | 19 / 3 / 10 | 4 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 12 | [www.gov.br](https://www.gov.br/saude/pt-br/campanhas-da-saude/2026/triplice-viral) | needs-review | 25 / 1 / 9 | 3 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 13 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/sobretudo/carreiras/2026/10/nao-sabe-para-onde-ir-na-carreira-aprenda-a-definir-seus-objetivos.shtml) | article-restricted | — | — | [Observed] 可见订阅/阅读限制，保留 article-restricted；未绕过访问限制。 |
| 14 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/ambiente/2026/10/seca-e-calor-extremos-do-ultimo-el-nino-antecipam-novo-normal-nas-florestas-tropicais.shtml) | article-restricted | — | — | [Observed] 可见订阅/阅读限制，保留 article-restricted；未绕过访问限制。 |
| 15 | [canaltech.com.br](https://canaltech.com.br/entretenimento/crunchyroll-animes-imperdiveis-outubro-2026/) | needs-review | 31 / 9 / 8 | 9 / 0 | [Observed] 新一轮遇到 Notsy 已映射视频位注入，曾多取 1 张推广封面并触发 partial；补充真实样本回放与广告位标记清理后复测，8 个动画条目、其列表与原有照片保留。 |
| 16 | [www.cultura.sc.gov.br](https://www.cultura.sc.gov.br/programacao/tipo/exposicao/3960-exposicao-pinturas-derivas?date=2026-10-13-00-00) | needs-review | 13 / 1 / 1 | 1 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 17 | [www.lance.com.br](https://www.lance.com.br/tenis/thiago-wild-deixa-mais-um-torneio-e-aumenta-duvida-sobre-retorno.html) | needs-review | 10 / 1 / 0 | 2 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 18 | [www.gov.br](https://www.gov.br/jbrj/pt-br/assuntos/noticias/semana-nacional-de-ciencia-e-tecnologia-2026-201cciencia-delas-destaca-o-papel-de-mulheres-cientistas) | needs-review | 5 / 1 / 0 | 1 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 19 | [www.cnnbrasil.com.br](https://www.cnnbrasil.com.br/auto/quatro-cuidados-para-ter-no-carro-durante-periodo-da-primavera-confira/) | partial | 14 / 4 / 0 | 2 / 0 | [Observed] 清除全屏按钮图标；2 张主文档照片就绪。Web Story 实测 HTTP 200，有 11 个 amp-story-page；其正文与图片未合并，保持 partial。 |
| 20 | [www.correiobraziliense.com.br](https://www.correiobraziliense.com.br/brasil/2026/09/7510825-viagem-de-carro-5-dicas-para-trafegar-com-seguranca-pelas-rodovias.html) | needs-review | 15 / 2 / 3 | 3 / 0 | [Observed] 5 条驾驶建议及 3 张主文档照片保留；移除 Saiba Mais 推荐区的 6 张缩略图和分享区 1 张二维码。图注、放大/轮播 SVG 不再误判；partial → needs-review。 |
| 21 | [record.r7.com](https://record.r7.com/fala-brasil/mulheres-positivas/video/mulheres-positivas-influenciadora-promove-autonomia-feminina-com-dicas-sobre-cuidados-automotivos-26092026/) | partial | 8 / 2 / 0 | 1 / 0 | [Observed] 去掉分享/播放器控件和广告播放器；Google News 等控件 LI 不再充当编辑列表。正文与视频封面保留，真实视频仍未获取，保持 partial。 |
| 22 | [www.estadao.com.br](https://www.estadao.com.br/jornal-do-carro/oito-sinais-de-que-os-freios-do-seu-carro-vao-falhar/) | needs-review | 43 / 4 / 3 | 3 / 0 | [Observed] 3 张纵向配图的字节哈希、尺寸与基线完全相同；一处图片 alt 从空值变为 Mecânico，导致语义哈希变化，正文未丢失。元数据独有、DOM 无匹配的额外封面仍待人工核对，未强行补入。 |
| 23 | [www.bcb.gov.br](https://www.bcb.gov.br/detalhenoticia/21283/nota) | article-short | — | — | [Observed] 原公告正文确实过短，保留 article-short。 |
| 24 | [www.bcb.gov.br](https://www.bcb.gov.br/detalhenoticia/21276/noticia) | needs-review | 8 / 0 / 0 | 0 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 25 | [www.bcb.gov.br](https://www.bcb.gov.br/detalhenoticia/21275/nota) | needs-review | 1 / 0 / 0 | 0 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 26 | [www.gov.br](https://www.gov.br/suframa/pt-br/assuntos/noticias/suframa-e-receita-federal-discutem-implementacao-da-reforma-tributaria-na-zona-franca-de-manaus-e-areas-de-livre-comercio) | needs-review | 11 / 1 / 0 | 2 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 27 | [www.gov.br](https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/outubro/operacao-inflamavel-ii-da-receita-federal-apura-aproveitamento-indevido-de-creditos-de-pis-pasep-e-cofins-na-revenda-de-oleo-diesel-gasolina-e-etanol) | needs-review | 14 / 1 / 0 | 1 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |
| 28 | [www.gov.br](https://www.gov.br/nfse/pt-br/noticias/comite-gestor-da-nfs-e-se-reune-belo-horizonte-mg-para-homologar-novas-funcionalidades-para-a-reforma-tributaria) | needs-review | 8 / 1 / 0 | 2 / 0 | [Observed] 主文档段落、标题与编辑列表覆盖检查通过；图片地址变体和正文范围仍按质量原因核对。 |

## 修复、验证与回滚

- DONE：capture.js 清理有明确语义/组件标记的广告、分享、轮播与播放器菜单；保留图注、照片、嵌套编辑列表和真实图表。空控件 LI 不生成列表。
- DONE：公开 video poster 经原图网络策略、格式、像素、字节预算和真实解码校验；已有封面不重复插入，视频仍提示未获取。
- DONE：unsupported-graphic 诊断按 iframe/video/audio/drawing 和 origin 汇总，沿用原质量阻断语义；有界事件不含 URL 路径或查询。
- DONE：audit-rich-capture.mjs 比较所有非空段落（含短段落），区分发布者正文与明确推荐/控件，递归统计列表项；保留元数据 URL/DOM 图片未匹配数量供复核，未把它们等同漏图。
- DONE：先 RED 后 GREEN 复现控件 SVG、控件列表、遗漏 poster、广告视频封面误入；真实 SVG 图表、报道 iframe、嵌套列表及封面复用有保护。
- DONE：工具包 23 文件 / 358 项、插件 15 文件 / 147 项测试通过；插件 check、语法、README 配对检查通过。
- DONE：28 篇采用原配置：代理 127.0.0.1:7897、Cloudflare DoH、60 秒 HTTP/120 秒渲染预算、并发 2、16 MB HTML 上限。结果写入独立私有目录 C:/Users/haige/AppData/Local/Temp/article-partials-ru5ePI/accepted28，不写业务库、不调用模型或真实生图。
- BLOCKED：4 篇真实嵌入媒体尚未完整获取；6 篇阅读受限与1篇真实短公告仍不具备完整分析输入。
- NEXT：为公开 Web Story 建立明确的子页面适配、来源链接及完整性检查；视频/音频如需独有内容，须另行提供完整可访问材料。

修改文件：src/capture.js、test/capture.test.js、scripts/audit-rich-capture.mjs、README.md/README.zh.md/README.i18n.yaml、父插件 src/client/locales/{zh,en}.json 与 client.js，及本报告目录。UI 只新增诊断事件的中英文文案并重建 client.js，布局保持原样。运行配置仅为 Canaltech 已确认的广告位增加 excludeSelector，模型和代理/DoH 保留。

[Observed] Web 已通过 dsh web profile 重启并加载工作台；28 条现有队列可读，运行日志 / Debug 可切换，控制台错误 0，无横向溢出及旧读取失败横条。业务 state.v2.json 文件哈希保持不变，测试快照不会覆盖既有审核记录；工作台已有记录须重新获取才会应用新的提取规则。

本轮之前源文件的副本：C:/Users/haige/AppData/Local/Temp/article-partials-ru5ePI/before；Web profile 原件：C:/Users/haige/AppData/Local/Temp/article-partials-ru5ePI/cordis.patch.before.yml。只恢复对应文件或该条选择器，不用 Git 重置整个插件，以保留之前的未提交改动。详细前后文件哈希见本轮私有 scope-check.json。
