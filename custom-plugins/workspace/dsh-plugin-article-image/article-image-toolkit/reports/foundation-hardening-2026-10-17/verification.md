# MCP 工具包基础完善验证报告

执行日期：2026-10-17。本报告记录本轮修改与实测，不替代工具包 README。用户确认的范围为生命周期、错误分类、MCP 进度与诊断、原图候选回退。

## 交付结果

| 项目 | 状态 | 行为与证据 |
|---|---|---|
| 生命周期 | DONE | 服务拒绝关闭后的新操作，取消在途抓取，等待原子写入及浏览器清理；重复 dispose 共享关闭过程。旧渲染器收到取消会关闭本次 context；持久配置只关闭本次 page。共享富文本内核即使关闭浏览器失败，也等待在途提取结束。 |
| 错误分类 | DONE | 编号文本与富文本共用 HTTP 分类：404 / 429 / 5xx / 其他非 2xx 分别保留 article-not-found / article-rate-limit / article-server / article-access。现有失败族与阶梯升级规则不变。 |
| MCP 进度与诊断 | DONE | fetch 与 capture_source 支持带 progressToken 的阶段通知，进度值为递增事件序号；同阶段默认 250ms 节流。成功结果返回 diagnosticId，错误通过 _meta.diagnosticId 返回 ID，并保留原错误码。新增 article_image_diagnostics 分页读取脱敏记录。 |
| 原图候选回退 | DONE | 保留有序候选，处理逗号 URL 与 picture 归属；失败后尝试其他公开来源，复用下载结果，按字节去重并保留各图位置及图注。尝试次数和全部下载预算有界，公网策略拒绝立即停止该图。 |

## 验证结果

| 检查 | 结果 | 说明 |
|---|---|---|
| 工具包完整测试 | PASS | 22 个测试文件，279 项通过，含真实 Chromium、MCP v1/v2 stdio、EOF、取消、持久化及诊断脱敏；1 份协议通知快照匹配。 |
| 父插件受影响链路 | PASS | workflow-v2、native-tools、config、article-fetch、analysis-contracts 共 41 项通过；最终共享内核版本再次验证 workflow-v2 与 config 共 19 项通过。19 是前述集合的复测，不重复计数。 |
| 同输入抽取对比 | PASS | 修改前代码副本与当前代码读取相同的 27 份已保存原始响应，结果全部一致；26 份已保存文章的段落重建及哈希计算全部一致。缺失的一份原始响应不计作已验证。 |
| 真实网络前后对照 | PASS | 修改前 24/28，当前 25/28；旧版本成功的 24 篇当前全部成功，且 24 篇正文哈希全部一致。详见 live-before-after-comparison.json。 |
| 历史单批 26/28 指标 | FAIL | 当前两次均为 25/28，另有两篇预期的 article-short 和一篇超时；超时文章在两次运行中不同。没有把单篇重试或跨批成功集合算作整批 26/28。 |
| 编码与语法 | PASS | 22 个本轮修改/新增 JS 文件通过 node --check；修改文件 UTF-8 无 BOM、无替换字符，保留单个末尾换行。 |
| 文档 | PASS | README 中英文配对校验及相对链接检查通过。新增配置、诊断保留策略、退出和候选回退语义已同步。 |
| 分发检查 | PASS | npm pack --dry-run --ignore-scripts --json 包含 diagnostics 模块；reports 不进入分发包。依赖版本、压缩包 SHA-512 与锁文件一致。未执行发布。 |
| 作用域 | PASS | 修改前记录的文件中，工具包以外仅 pnpm-lock.yaml 有本轮变化；去除新解析器三处记录后，其 SHA-256 与修改前完全一致。原有工作台、Host、OpenSpec 及其他未提交改动保持原值。 |

根 Oxlint 配置不包含此自定义 JS 工具包，直接调用报告 No files found。独立临时配置的基础检查退出码为 0，报告 9 条警告：既有未使用变量与 spread 风格提示，以及本轮 allSettled 显式集合副本的风格提示。未将它表述为仓库 lint 全绿，也未执行全仓构建或测试。

## 真实网络数据及验收限制

历史基线仍为 2026-10-17 的 26/28、两篇 article-short、104 秒。本轮不修改该历史数字。两次整批均使用请求 60 秒、渲染 120 秒、并发 2、fallback、缓存关闭。

第一次执行原有 scripts/live-check.mjs：25/28，265.8 秒，Estadao 一篇 article-timeout，两篇 BCB 公告 article-short。其余 25 篇成功，包括 OTempo。

对第一次超时的 Estadao 链接做修改前/修改后顺序对比：修改前 12,808ms、修改后 15,163ms，均成功取得 55 段、7,443 字符，内容哈希完全相同。该单篇实验支持“该超时不是稳定复现的抽取退步”，不支持“新实现提速”。

第二次使用当前代码独立执行 28 条完整批量：25/28，329.6 秒，OTempo 一篇 article-timeout，两篇 BCB 公告 article-short；Estadao 成功。两次成功集合覆盖了历史基线的 26 篇，但单次完整批量达到 26/28 的严格网络验收尚未通过。

随后将修改前备份代码置于相同依赖和预算下，重新读取完整 28 条 fixture：24/28，258.2 秒，OTempo 与 Suframa 两篇 article-timeout，两篇 BCB 公告 article-short。修改前成功的 24 篇在当前批量中全部成功，段落内容哈希也全部相同；当前额外取得了 Suframa。完整逐篇结果分别保存在 before-live-regression.json 与 final-live-regression.json。

Observed：相同已存响应的抽取与哈希无差异；现场前后 24 篇共同成功文章的哈希完全一致，未出现旧版成功而新版失败的链接；两次当前版本的超时落在不同文章；Estadao 修改前后均能取得相同正文。Inferred：当前网络或源站时延存在波动。上述批量不是同时采样，不能据此断言成功率提升、提速、所有超时已修复、网络稳定性达标，或任意文章都能完整抓取。

## 诊断使用与限制

1. 客户端给 tools/call 提供 _meta.progressToken，可接收 notifications/progress；progress 是事件序号，不是完成百分比。
2. 从成功结果的 diagnosticId 或错误结果的 _meta.diagnosticId 取 ID，再调用 article_image_diagnostics({ diagnosticId, offset: 0 })，沿 nextOffset 读取到 null。
3. 诊断记录阶梯、阶段、原图候选失败、HTTP 状态、计数与耗时；文章/正文块只用受限 ID，URL 只保留 origin。不保存正文、完整路径、查询、Cookie、请求头与远端错误原文。
4. 默认仅在当前进程保留 20 次调用、每次 128 条事件；超限淘汰，重启丢失。droppedEvents 表示淘汰数量；过期 ID 返回 diagnostic-missing。本期没有新增 Web 日志标签或修改页面样式。

maxDiagnosticRuns、maxDiagnosticEvents、progressIntervalMs 可通过对应 CLI 参数与 ARTICLE_IMAGE_* 环境变量调整；capture.maxImageCandidates 默认 5，范围 1–20。完整说明在 README.zh.md。

## 依赖与安全复核

唯一新增运行依赖是固定版本 @prettier/parse-srcset@3.1.0，无新增传递运行依赖。[官方源码](https://github.com/prettier/parse-srcset/blob/main/index.js)对畸形描述符抛错；[许可证](https://github.com/prettier/parse-srcset/blob/main/license)为 MIT。本工具包在属性级捕获错误且不记录其原文，保留其他属性及浏览器选中来源。

审查中实测发现最初候选 parse-srcset 会把畸形属性和签名 URL 打到 stdout，已通过失败测试复现并替换；最终生产依赖与两份锁文件只保留 @prettier/parse-srcset。测试确认畸形属性不会污染 MCP stdout。

每个回退 URL 仍走原有公网地址校验、DNS 固定与同源跳转策略。失败响应字节计入总量；无法计量已读字节的失败请求预占本次额度，因此连续网络失败可能较早耗尽图片预算。该策略不会为成功回退扩大整篇字节上限。

未接入生图、TLS provider、登录/付费墙处理或验证码服务；没有安装 Python 或浏览器运行时。浏览器验证使用本机已有 Chromium。

## 修改清单、影响与回退

完整逐文件清单见 scope-verification.json，原有文件 21 个，本轮新增代码/测试文件 7 个；报告目录单独保存验证产物。

| 文件组 | 目的及影响 |
|---|---|
| src/service.js、src/render.js、src/server.js | 统一拥有异步操作、关闭与取消；接通阶段通知。 |
| src/contracts.js、src/articles.js、src/capture.js | 共用 HTTP 分类；富文本内核关闭等待；候选选择与解析。 |
| src/capture-media.js、src/capture-service.js | 原图回退及预算；透传进度至不可变快照保存。 |
| src/diagnostics.js、src/tools.js | 有界脱敏诊断、新增只读 MCP 工具，保留原工具结果与错误字段。 |
| src/config.js、bin/article-image-toolkit.js | 诊断保留及节流部署参数。 |
| package.json、package-lock.json、根 pnpm-lock.yaml | 固定标准 srcset 解析依赖；其他原有锁定记录保留。 |
| README.md、README.zh.md、README.i18n.yaml | 双语使用说明与一致性记录。 |
| test/ 中列明文件 | 复现并覆盖 HTTP、生命周期、原图、通知、脱敏、v2 客户端与 EOF 退出；更新工具目录断言。 |

快照 schema、sourceHash 算法所在模块保持原字节。默认抓取传输、抽取算法、模型分析、人工审核、工作台样式及真实生图状态不变。

修改前文件备份位于 C:/Users/haige/AppData/Local/Temp/article-toolkit-foundations-EadVGo/before/，目录结构与仓库相同；根锁文件也已按修改前 SHA-256 恢复出准确副本。回退须逐文件比对并保留随后产生的用户改动，不能对当前脏工作区执行整仓 git restore/reset。

## 后续验收

四个基础功能、同输入回归及现场“旧版成功链接不减少”的对照为 DONE。历史单次整批 26/28 指标本轮实测 FAIL，后续为 NEXT：记录超时请求的网络/渲染阶段，在稳定网络下重跑同预算批量并保留逐篇结果，确认完整批量重新达到该历史指标。真实模型理解和人工语义审核仍由用户手动验证，真实生图维持未接入。

## 28 条逐篇结果

| # | 公开文章 | 修改前批量 | 当前批量 | 同一已存原始响应 |
|---|---|---|---|---|
| 1 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/turismo/2026/10/roteiro-de-36-horas-no-lago-de-como-na-italia-destaca-vilarejos-arte-e-gastronomia.shtml) | 59 段 / 12469 字符 | 59 段 / 12469 字符 | 一致 |
| 2 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/turismo/2026/08/taiwan-e-destino-turistico-vibrante-apesar-de-tensoes-com-a-china.shtml) | 22 段 / 6699 字符 | 22 段 / 6699 字符 | 一致 |
| 3 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/turismo/2026/07/resort-oiti-beach-e-base-confortavel-para-conhecer-tutoia-no-maranhao.shtml) | 9 段 / 2395 字符 | 9 段 / 2395 字符 | 一致 |
| 4 | [www.metropoles.com](https://www.metropoles.com/conteudo-especial/orlando-com-bebes-e-criancas) | 24 段 / 6317 字符 | 24 段 / 6317 字符 | 一致 |
| 5 | [www.correiobraziliense.com.br](https://www.correiobraziliense.com.br/aqui/2026/08/06/7-destinos-na-argentina-para-fugir-da-alta-do-dolar-e-aproveitar/) | 9 段 / 2934 字符 | 9 段 / 2934 字符 | 一致 |
| 6 | [www.correiobraziliense.com.br](https://www.correiobraziliense.com.br/aqui/2026/08/06/mallorca-5-passeios-para-fazer-na-ilha-espanhola-paradisiaca/) | 14 段 / 2674 字符 | 14 段 / 2674 字符 | 一致 |
| 7 | [www.otempo.com.br](https://www.otempo.com.br/turismo/2026/7/23/temporada-de-aguas-mais-cristalinas-em-bonito-6-passeios-imperdiveis) | article-timeout | article-timeout | 无保存响应 |
| 8 | [guia.folha.uol.com.br](https://guia.folha.uol.com.br/restaurantes/2026/10/festival-gastronomico-da-folha-tem-curadoria-musical-do-blue-note.shtml) | 24 段 / 4444 字符 | 24 段 / 4444 字符 | 一致 |
| 9 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/comida/2026/10/veja-como-fazer-a-buchimgae-panqueca-coreana-com-receita-de-arthur-paek.shtml) | 32 段 / 1757 字符 | 32 段 / 1757 字符 | 一致 |
| 10 | [guia.folha.uol.com.br](https://guia.folha.uol.com.br/restaurantes/2026/10/saiko-leva-sandos-sanduiches-ao-estilo-japones-a-festival-gastronomico-da-folha.shtml) | 18 段 / 2780 字符 | 18 段 / 2780 字符 | 一致 |
| 11 | [g1.globo.com](https://g1.globo.com/sp/vale-do-paraiba-regiao/especial-publicitario/festa-das-flores-e-morangos-de-atibaia/flores-e-morangos/noticia/2026/09/10/festa-em-atibaia-flores-morangos-gastronomia-e-cultura-japonesa-sao-atracoes.ghtml) | 27 段 / 7115 字符 | 27 段 / 7115 字符 | 一致 |
| 12 | [www.gov.br](https://www.gov.br/saude/pt-br/campanhas-da-saude/2026/triplice-viral) | 43 段 / 1693 字符 | 43 段 / 1693 字符 | 一致 |
| 13 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/sobretudo/carreiras/2026/10/nao-sabe-para-onde-ir-na-carreira-aprenda-a-definir-seus-objetivos.shtml) | 38 段 / 7296 字符 | 38 段 / 7296 字符 | 一致 |
| 14 | [www1.folha.uol.com.br](https://www1.folha.uol.com.br/ambiente/2026/10/seca-e-calor-extremos-do-ultimo-el-nino-antecipam-novo-normal-nas-florestas-tropicais.shtml) | 27 段 / 9031 字符 | 27 段 / 9031 字符 | 一致 |
| 15 | [canaltech.com.br](https://canaltech.com.br/entretenimento/crunchyroll-animes-imperdiveis-outubro-2026/) | 49 段 / 7086 字符 | 49 段 / 7086 字符 | 一致 |
| 16 | [www.cultura.sc.gov.br](https://www.cultura.sc.gov.br/programacao/tipo/exposicao/3960-exposicao-pinturas-derivas?date=2026-10-13-00-00) | 20 段 / 1900 字符 | 20 段 / 1900 字符 | 一致 |
| 17 | [www.lance.com.br](https://www.lance.com.br/tenis/thiago-wild-deixa-mais-um-torneio-e-aumenta-duvida-sobre-retorno.html) | 13 段 / 2021 字符 | 13 段 / 2021 字符 | 一致 |
| 18 | [www.gov.br](https://www.gov.br/jbrj/pt-br/assuntos/noticias/semana-nacional-de-ciencia-e-tecnologia-2026-201cciencia-delas-destaca-o-papel-de-mulheres-cientistas) | 28 段 / 7634 字符 | 28 段 / 7634 字符 | 一致 |
| 19 | [www.cnnbrasil.com.br](https://www.cnnbrasil.com.br/auto/quatro-cuidados-para-ter-no-carro-durante-periodo-da-primavera-confira/) | 23 段 / 3184 字符 | 23 段 / 3184 字符 | 一致 |
| 20 | [www.correiobraziliense.com.br](https://www.correiobraziliense.com.br/brasil/2026/09/7510825-viagem-de-carro-5-dicas-para-trafegar-com-seguranca-pelas-rodovias.html) | 22 段 / 2948 字符 | 22 段 / 2948 字符 | 一致 |
| 21 | [record.r7.com](https://record.r7.com/fala-brasil/mulheres-positivas/video/mulheres-positivas-influenciadora-promove-autonomia-feminina-com-dicas-sobre-cuidados-automotivos-26092026/) | 51 段 / 4996 字符 | 51 段 / 4996 字符 | 一致 |
| 22 | [www.estadao.com.br](https://www.estadao.com.br/jornal-do-carro/oito-sinais-de-que-os-freios-do-seu-carro-vao-falhar/) | 55 段 / 7443 字符 | 55 段 / 7443 字符 | 一致 |
| 23 | [www.bcb.gov.br](https://www.bcb.gov.br/detalhenoticia/21283/nota) | article-short | article-short | 一致 |
| 24 | [www.bcb.gov.br](https://www.bcb.gov.br/detalhenoticia/21276/noticia) | 8 段 / 3661 字符 | 8 段 / 3661 字符 | 一致 |
| 25 | [www.bcb.gov.br](https://www.bcb.gov.br/detalhenoticia/21275/nota) | article-short | article-short | 一致 |
| 26 | [www.gov.br](https://www.gov.br/suframa/pt-br/assuntos/noticias/suframa-e-receita-federal-discutem-implementacao-da-reforma-tributaria-na-zona-franca-de-manaus-e-areas-de-livre-comercio) | article-timeout | 8 段 / 3357 字符 | 一致 |
| 27 | [www.gov.br](https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/outubro/operacao-inflamavel-ii-da-receita-federal-apura-aproveitamento-indevido-de-creditos-de-pis-pasep-e-cofins-na-revenda-de-oleo-diesel-gasolina-e-etanol) | 12 段 / 2639 字符 | 12 段 / 2639 字符 | 一致 |
| 28 | [www.gov.br](https://www.gov.br/nfse/pt-br/noticias/comite-gestor-da-nfs-e-se-reune-belo-horizonte-mg-para-homologar-novas-funcionalidades-para-a-reforma-tributaria) | 6 段 / 2443 字符 | 6 段 / 2443 字符 | 一致 |
