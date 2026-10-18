# Scrapling 主导方案可行性评审

评审日期：2026-10-17，Asia/Shanghai。范围：article-image-toolkit 的静态请求、抽取、渲染及其 MCP 接入；本轮没有实现 provider，没有修改产品源码、依赖清单、配置或现有测试。只增加本报告与派生实验数据。用户提供的版本、240 测试/17 文件、26 成功+2 条 article-short、104 秒验收基线保持原样；本轮网络采样另行列明，不替换历史基线。

标记：**Observed** 为本轮代码/实验直接证据；**Inferred** 为由证据推导的设计判断；**Assumed** 为待验收的设想或工时估算。静态源码依据为本机文件及官方固定 commit，实验脚本、原始响应和日志位于 [隔离证据目录](C:/Users/haige/AppData/Local/Temp/scrapling-feasibility-20261017-204925/)。

## 三个最小实验：原始输出

**Observed，实验 1**：在临时 venv 执行 `python -m pip install "scrapling[ai]==0.4.15"`，不执行 `scrapling install`。安装输出包含 `Successfully installed ... scrapling-0.4.15 ... curl_cffi-0.16.3 ... mcp-2.3.0`；stdio 实际握手结果：

```text
{"experiment":1,"stdio":"ready","startupMs":1558,"tools":["open_session","open_request_session","close_session","list_sessions","make_request","bulk_get","fetch","bulk_fetch","stealthy_fetch","bulk_stealthy_fetch","session_fetch","session_make_request","screenshot"]}
```

**Observed，实验 2**：现有 `node scripts/live-check.mjs 1` 与相同 fixture 首条 URL 的 MCP 请求：

```text
Retrieving 1 articles (concurrency 2)...
completed 1/1 in 5.8s
OK    Travel                               59 paras  https://www1.folha.uol.com.br/turismo/2026/10/roteiro-de-36-ho
Failure codes: none
{"experiment":"experiment-2-first-url","url":"https://www1.folha.uol.com.br/turismo/2026/10/roteiro-de-36-horas-no-lago-de-como-na-italia-destaca-vilarejos-arte-e-gastronomia.shtml","ms":1214,"isError":false,"status":200,"contentChars":320682}
```

**Observed，口径限制**：live-check 包含抽取和记录保存；make_request 包含 HTTP、Python 解析/转换及 MCP 传输，不含我们的 Readability。这组首次值不能直接计算提速比例；同操作的五次中位数见第七节。

**Observed，实验 3**：先用现有公网固定请求确认 403/article-access，再调用 make_request。以下是最后一轮默认 Markdown 输出；URL 为新闻站首页，只证明这三个入口的拒绝变化，不证明其任意文章全文可读。

```text
Node: https://apnews.com/         status=403 code=article-access ms=3082
Node: https://edition.cnn.com/    status=403 code=article-access ms=714
Node: https://www.usatoday.com/   status=403 code=article-access ms=870
{"experiment":"experiment-3-site-1","url":"https://apnews.com/","ms":7914,"isError":false,"status":200,"contentChars":188072}
{"experiment":"experiment-3-site-2","url":"https://edition.cnn.com/","ms":5210,"isError":false,"status":200,"contentChars":55453}
{"experiment":"experiment-3-site-3","url":"https://www.usatoday.com/","ms":892,"isError":false,"status":403,"contentChars":179}
```

**Observed**：没有出现“三站仍全部 403”；AP 与 CNN 返回正常网站内容，USA Today 仍 403。未执行验证码、登录或付费操作。**Inferred**：可以继续评审 HTTP 能力；这不足以证明 TLS ClientHello 是唯一因果变量，两个客户端的 User-Agent、默认头和 Referer 也不同。

**Observed，先前失败原样保留**：CNN 的 html/False 首次尝试在上游日志显示 HTTP 200 后断开。独立复现时客户端报告：

```text
ReadBuffer exceeded maximum size of 10485760 bytes
MCP error -32000: Connection closed
```

失败后第三个站出现的 `Not connected` 是子进程/连接故障，未计作 403。28 篇质量实验显式使用 64 MiB 接收上限以继续测量；这是实验设置，不是生产安全方案。

## 一、结论

**Inferred：A 部分采纳**——只批准进入“可选 TLS HTTP provider”的设计/试点；不替换默认 Node static，不直接嵌套原版 scrapling-mcp 上线。
**Inferred：B 不采纳**——继续 JSDOM/Readability 与现有质量判定，Scrapling 直接 Markdown 不作为文章正文。
**Inferred：C 不采纳**——继续现有 JS/patchright 渲染与双投影；“Scrapling 全面主导”当前为 **No-Go**。

## 二、A/B/C 三层判定表

| 层 | 判定 | 一句理由 | 证据 |
|---|---|---|---|
| A 抓取主导 | 部分采纳，仅可选 provider | Observed：部分 403 得到 200、首条 HTTP 中位数变快；但默认替换使28篇成功数26→24，原MCP缺bytes/headers、DNS pin及可分类异常。 | 第三/五/六/七节；[src/fetch.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/fetch.js:50)；[ResponseModel](https://github.com/D4Vinci/Scrapling/blob/333fa22b7a5821194ce66b59b11f4b16a6484f02/scrapling/core/ai.py#L96-L101) |
| B 抽取主导 | 不采纳 | Observed：22份达到长度门槛的Markdown首段均与原结果不同，导航/页头噪声明显；A保留抽取时24篇逐段相同。 | 下方28篇表；[src/articles.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/articles.js:354)；[转换实现](https://github.com/D4Vinci/Scrapling/blob/333fa22b7a5821194ce66b59b11f4b16a6484f02/scrapling/core/shell.py#L622-L660) |
| C 渲染主导 | 不采纳 | Inferred：本轮没有新增渲染收益证据，现有DOM/可见文本、cookie及富文本捕获仍需另行迁移；维持现有实现成本较低。 | [src/render.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/render.js:88)；[stealthy_fetch参数](https://github.com/D4Vinci/Scrapling/blob/333fa22b7a5821194ce66b59b11f4b16a6484f02/scrapling/core/ai.py#L734-L761) |

**Observed，实际作用范围**：[src/tools.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/tools.js:41) 进入 readArticle 文本阶梯；[src/service.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/service.js:60) 进入独立富文本捕获服务。只改 static transport 不会自动改善 rich capture 的正文块、图片或插件页面获取；两条路径不能混为一次接入。

## 三、抽取质量实测对比

**Observed，实验定义**：N＝现有完整阶梯；A＝make_request(html, main_content_only=False) 取回重序列化 HTML，继续现有 structured/JS browser/抽取；B＝make_request(markdown, main_content_only=True) 直接返回，不再进行 DOM 抽取。N/A 的字符数为存储段落用双换行连接后的UTF-16单元数；B为原始Markdown字符串字符数，包含Markdown标记，段落按原articleRecord规则分块。B的“达到长度门槛”不等于正文质量通过。

**Observed**：N 26成功、2条article-short；A 24成功且24篇 paragraph 数组逐项完全相同，O Tempo(#7)/Estadão(#22)为上游错误，另两条短公告保持article-short；B 22份HTTP成功且达到长度门槛、其余6份失败/空。SHORT=article-short；UP=评测适配器的upstream-tool-error标签，未新增到产品错误码；B的403优先按HTTP失败解释，不把短错误JSON当文章。A首段“同N”表示已比较整份paragraph数组。原始每篇URL和完整首段见 [quality-28.csv](quality-28.csv)，原始度量见 [quality-results.json](quality-results.json)。

| # | 发布方 | N 段/字符 | N 首段节选 | A 段/字符 | A 首段 | B 段/字符 | B 首段节选 |
|---|---|---:|---|---:|---|---:|---|
| 1 | folha.uol.com.br | 59 / 12585 | Em uma palavra, o Lago de Como, na Itália, deslu… | 59 / 12585 | 同 N | 246 / 44144 | Últimas notícias |
| 2 | folha.uol.com.br | 22 / 6741 | Taiwan vive no centro de uma das maiores tensões… | 22 / 6741 | 同 N | 213 / 36563 | Últimas notícias |
| 3 | folha.uol.com.br | 9 / 2411 | Por ser um destino turístico ainda em ascensão, … | 9 / 2411 | 同 N | 200 / 31491 | Últimas notícias |
| 4 | metropoles.com | 24 / 6363 | Viajar com bebês e crianças pequenas pode ser um… | 24 / 6363 | 同 N | 47 / 10692 | Menu |
| 5 | correiobraziliense.com.br | 9 / 2950 | A Argentina se tornou um dos destinos mais atrat… | 9 / 2950 | 同 N | 65 / 13955 | [![Correio Braziliense - Aqui](https://www.corre… |
| 6 | correiobraziliense.com.br | 14 / 2700 | Mallorca ganhou os holofotes recentemente ao sed… | 14 / 2700 | 同 N | 74 / 13044 | [![Correio Braziliense - Aqui](https://www.corre… |
| 7 | otempo.com.br | 22 / 6840 | Se há algo que encanta em Bonito é a transparênc… | UP | — | UP | — |
| 8 | guia.folha.uol.com.br | 24 / 4490 | São Paulo O Folha Gourmet Festival, que acontece… | 24 / 4490 | 同 N | 94 / 17685 | [Assine a folha](https://assinaturas.folha.com.b… |
| 9 | folha.uol.com.br | 32 / 1819 | Que a cultura sul-coreana é um sucesso na música… | 32 / 1819 | 同 N | 190 / 30331 | Últimas notícias |
| 10 | guia.folha.uol.com.br | 18 / 2814 | São Paulo Sanduíches ao estilo japonês, os sando… | 18 / 2814 | 同 N | 87 / 15015 | [Assine a folha](https://assinaturas.folha.com.b… |
| 11 | g1.globo.com | 27 / 7167 | Com uma tradição que começou em 1984, a Festa re… | 27 / 7167 | 同 N | 403 / 69 | {"code":"403","message":"Forbidden","RequestId":… |
| 12 | gov.br | 43 / 1777 | A vacinação ajudou o Brasil a interromper a circ… | 43 / 1777 | 同 N | 85 / 36322 | [Ir para o Conteúdo 1](#wrapper) [Ir para a Pági… |
| 13 | folha.uol.com.br | 38 / 7370 | Esta é uma edição da newsletter Folha Carreiras.… | 38 / 7370 | 同 N | 218 / 36385 | Últimas notícias |
| 14 | folha.uol.com.br | 27 / 9083 | Cerca de 75% das áreas das florestas tropicais d… | 27 / 9083 | 同 N | 196 / 38694 | Últimas notícias |
| 15 | canaltech.com.br | 49 / 7182 | Após a intensa temporada em julho, a Crunchyroll… | 49 / 7182 | 同 N | 61 / 12542 | Canaltech - Notícias de Tecnologia, Ciência e En… |
| 16 | cultura.sc.gov.br | 20 / 1938 | MASC | 20 / 1938 | 同 N | 44 / 18253 | Pesquisar... |
| 17 | lance.com.br | 13 / 2045 | Thiago Seyboth Wild não participará do Challenge… | 13 / 2045 | 同 N | 108 / 24195 | Clubes |
| 18 | gov.br | 28 / 7688 | De 27 de outubro a 1º de novembro, a 23ª Semana … | 28 / 7688 | 同 N | 87 / 54385 | [Ir para o Conteúdo 1](#wrapper) [Ir para a Pági… |
| 19 | cnnbrasil.com.br | 23 / 3228 | A chegada da primavera muda algumas condições às… | 23 / 3228 | 同 N | 60 / 17191 | Quatro cuidados para ter no carro durante períod… |
| 20 | correiobraziliense.com.br | 22 / 2990 | A discussão sobre a fiscalização da velocidade m… | 22 / 2990 | 同 N | 70 / 17899 | Seções |
| 21 | record.r7.com | 52 / 5057 | Além disso, ela enfatiza a importância das manut… | 52 / 5057 | 同 N | 178 / 83228 | [![Logo R7.com](https://static.themebuilder.aws.… |
| 22 | estadao.com.br | 55 / 7551 | Freios devem ser revisados a cada 10 mil km. Vej… | UP | — | UP | — |
| 23 | bcb.gov.br | SHORT | — | SHORT | — | 空 / 0 |  |
| 24 | bcb.gov.br | 8 / 3675 | O Banco Central do Brasil (BC) e o Banco Central… | 8 / 3675 | 同 N | 空 / 0 |  |
| 25 | bcb.gov.br | SHORT | — | SHORT | — | 空 / 0 |  |
| 26 | gov.br | 8 / 3371 | A Suframa e representantes da Superintendência R… | 8 / 3371 | 同 N | 66 / 43134 | [Ir para o Conteúdo 1](#wrapper) [Ir para a Pági… |
| 27 | gov.br | 12 / 2661 | A Receita Federal do Brasil realiza ações de mon… | 12 / 2661 | 同 N | 98 / 83501 | [Ir para o Conteúdo 1](#wrapper) [Ir para a Pági… |
| 28 | gov.br | 6 / 2453 | Entre os dias 5 e 9 de outubro, o Comitê Gestor … | 6 / 2453 | 同 N | 52 / 27306 | [Ir para o Conteúdo 1](#wrapper) [Ir para a Pági… |

**Observed，站点差异**：Folha 直接Markdown带“Últimas notícias”导航，Guia带订阅链接；Metrópoles带Menu；Correio带logo/Seções；Gov.br带无障碍跳转、站点菜单；Cultura带Pesquisar；Lance带Clubes；R7带logo与大量站点内容；CNN Brasil将页面标题/装饰性Markdown放在首段。BCB三页B均空，其中#24原本是8段有效正文，无法用纯静态Markdown替代SPA渲染。G1的Scrapling静态请求为403，A靠原JS browser恢复27段，而B停在403。

**Observed，现有能力也有局限**：N的#13首段仍是newsletter订阅引导，#16首段为MASC。26成功是可获取/抽取基线，不等于26篇经人工认证完全无噪声；不能用这一点替B的明显新增噪声开脱。

**Observed，源码解释**：[main_content_only](https://github.com/D4Vinci/Scrapling/blob/333fa22b7a5821194ce66b59b11f4b16a6484f02/scrapling/core/shell.py#L635-L646) 取body并删除噪声/隐藏节点，未执行Readability或选择article/main。html/False不是原始字节；它仍经过lxml解析及重序列化。**Inferred**：B会丢失[src/articles.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/articles.js:199)等DOM容器收窄、门闸节点识别及JSON-LD原脚本；“全部清理能力都失效”过强，[src/articles.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/articles.js:276)在纯文本路径仍可执行，但不能重建DOM或普遍去掉导航。替代为保留现有抽取，在传输层返回原始bytes/headers。

## 四、进程模型设计

**Inferred，推荐职责**：Node ArticleService继续拥有任务、阶梯、会话、缓存、限速和错误码。Python仅提供有预算的匿名HTTP请求。使用一个自有、窄接口Python bridge调用Scrapling/curl_cffi；不向Agent转发上游13工具，不让模型设置proxy、auth、cookies、任意headers、脚本或solver。可复用当前Node MCP Client/stdio SDK，无新增npm依赖。bridge仍须显式安装的Python及冻结requirements；本轮尚未实现。

| 状态/事件 | owner与行为 | 判定 |
|---|---|---|
| 首次请求 | provider owner创建唯一ready promise；共享一次启动/能力握手，校验固定协议、版本、预算和所需pin能力 | Inferred |
| 2/8/16请求 | Node负责全局上限与每host pacer；一个子进程内部并发等待网络，转换和stdout受CPU/背压限制 | Observed并发峰值见第七节；策略为Inferred |
| child崩溃 | 所有在飞调用得到受控provider失败；不自动重放；后续新GET请求才经配置的有上限退避重启 | Inferred |
| dispose开始 | 先标记closing拒接单，再abort全部调用；发MCP取消通知；登记并await在飞promise和child关闭 | Inferred |
| 关闭超时 | 先结束stdin/正常关闭，再终止，最后强制终止；每步等待exit，解除监听器；Windows需Job Object或等价子树回收保证 | Inferred，平台验收待做 |
| parent意外退出 | 依靠stdin EOF/父进程失活监视和平台进程组收尾，禁止仅启动detached child后不管 | Inferred，未实测parent硬杀 |

**Observed，不能直接复用的假定**：[src/service.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/service.js:58) 当前abort后等待三个renderer，并未登记所有static调用；受控deferred fetch实验中dispose在0.271ms返回时fetch尚未settle。[src/render.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/render.js:166) 也未await close()返回的promise。因此“现有dispose已自动等全部在飞操作”不是顶层服务的完整保证，新provider必须有自己的active set和dispose，并接入service的await。

**Observed，已做故障注入**：杀死仍有在飞请求的child，调用返回Connection closed；显式关闭后旧PID不存在；新建child可list_sessions；最终新PID也不存在。见 [crash-restart.json](crash-restart.json)。这证明本次SDK回收与手动重连，不代表自有生产监督器或parent硬杀保障已实现。

## 五、错误码映射表

**Observed**：[当前MCP SDK异常包装](https://github.com/modelcontextprotocol/python-sdk/blob/2118f14f8a19bc158d8a1cf90af58d85d187f849/src/mcp/server/mcpserver/tools/base.py#L194-L213) 隐藏非ToolError详情。本轮DNS解析阶段超时和连接阶段超时均只返回 `{content:[{type:"text",text:"Error executing tool make_request"}],isError:true}`。stderr含curl(28)细节，但禁止靠解析无保证日志或把可能含凭据的异常文本传给Agent。连接失败/超时/安全拒绝的精确分类必须在Python异常被包装前完成。以下是拟议bridge的映射，不声称原MCP已经具备。

| Scrapling/curl表现 | 我们的错误码 | 失败族 | 依据/状态 |
|---|---|---|---|
| DNS/连接失败、TLS证书/协议失败 | article-network | transport | Inferred映射typed exceptions；不解析通用MCP文本 |
| curl Timeout或外层自身deadline | article-timeout | transport | Observed现有语义；bridge须保留区别 |
| caller/service取消 | article-interrupted | transport | Observed现有语义 |
| HTTP 401/403且无更具体受限内容判定 | article-access | client | Observed [src/articles.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/articles.js:354) |
| HTTP 404 | article-not-found | decision | Observed |
| HTTP 429 | article-rate-limit | decision | Observed；保持有预算Retry-After而非浏览器回退 |
| HTTP 5xx | article-server | decision | Observed；503仅依现有Retry-After策略重试 |
| 过滤空白块后HTML无可抽正文 | article-extraction | content | Inferred适配；不能仅判断content数组长度，转换器会追加空块 |
| 有正文但不足minArticleChars | article-short | content | Observed现有长度判定 |
| HTML/文本被截断、正文超过maxArticleChars | article-truncated | content | Observed；本项目此码属于content，不擅自改成size |
| 网络字节或HTML输入预算超限 | article-resource-limit / article-html-limit | size | Observed [src/pipeline.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/pipeline.js:17) |
| 不支持Content-Type/编码 | article-unsupported | transport | Observed |
| 检出登录墙 / 付费限制 | article-login / article-restricted | decision | Observed；保留现有DOM判定，禁止用工具转换绕开 |
| 检出交互验证页 | article-challenge | content | Observed；保留现有有预算浏览器机会，禁止验证码solver/点击；仍有挑战就结束 |
| 初始URL或任一hop公网策略拒绝 | article-url-blocked | decision | Observed；由Node策略产生，不能依curl连接失败倒推 |
| 同源/跳数限制拒绝 | article-redirect | transport（当前默认） | Observed：当前family表未显式列此码，默认transport，不擅自改变 |
| 显式选中的Python/executable/包/协议缺失 | provider-unavailable | transport | Inferred新增可操作provider诊断；符合用户约束，禁止自动安装 |
| child退出/IPC超限/不可解析协议 | article-provider（公开安全结果） | transport | Inferred；保留内部reason作脱敏诊断，不把它伪装成HTTP403 |

**Observed**：[src/pipeline.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/pipeline.js:72) 按失败族选择后续级，未知码默认transport。因此把所有异常都压成operation-failed会失去client/content回退；把全部改成article-access则会对断网、404和付费页错误启动浏览器。**Inferred**：bridge返回受控code/status/headers，Node沿用该表；错误族规则须有逐项反例测试。

## 六、安全边界论证

1. **Observed + Inferred，初始URL与DNS固定**：现有[src/capture-media.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-media.js:59)、[src/capture-media.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-media.js:36)检查scheme/凭据、全部DNS地址及DNS64，[src/capture-media.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-media.js:103)固定连接地址。新provider每次调用和回放仍先过这些检查；Python必须实际使用Node给出的已验证地址（如CurlOpt.RESOLVE并禁止自己换DNS/代理），在TLS中保持原hostname/SNI。只把验证过的hostname交给Python二次解析存在重绑定时间差，原版make_request不提供pin字段，故当前原版MCP不能维持此保证。现有static的保证不自动覆盖另一进程或旧浏览器路径。
2. **Observed + Inferred，safe重定向**：Scrapling将safe传给curl_cffi，后者设置CurlFollow.SAFE=4；[原生socket检查](https://github.com/lexiforest/curl-impersonate/blob/107d67f9f7a518334b1b11e4810637e70b2671a7/patches/curl.patch#L1273-L1335)仅在follow阶段拒绝127/8、10/8、172.16/12、192.168/16、169.254/16、::1、fc00/7、fe80/10。它没有初始地址校验、同源限制，也未覆盖当前策略的映射IPv6和自定义DNS64。方案必须关闭自动跳转，由Node读取Location、逐跳重新captureUrl/公网校验/同源/跳数检查并传入固定地址；不能称safe等价于现有策略。
3. **Observed + Inferred，调用方参数不透传**：[src/tools.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/tools.js:41) 当前fetch仅接收记录id。继续只以严格schema组建bridge输入；拒绝额外headers/cookies/proxy/auth/body/solver等字段，而不是object spread。Node选择部署UA、预算和内部jar。子进程从允许列表构造环境，剔除所有大小写proxy及凭据变量；bridge显式空PROXY，做负向代理测试。curl_cffi虽然有trust_env参数，[相关请求实现](https://github.com/lexiforest/curl_cffi/blob/d7302948771801955bcef0d5288c137d7b74f49d/curl_cffi/requests/utils.py#L838-L886)不足以让仅设trust_env=False成为已验证保障。
4. **Observed + Inferred，唯一Cookie权威**：[src/session.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/session.js:81)管理domain/path/expiry/secure，[src/fetch.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/fetch.js:50)需要Set-Cookie及Retry-After，[src/cache.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/cache.js:69)需要缓存头。make_request每调用临时session不持久共享，但session_make_request会有独立jar；不要开放它。bridge每次只用Node jar的受控Cookie，单次请求关闭自动redirect和独立持久jar，原样返回各hop Set-Cookie给Node；用户headers/cookies不进入这个通道。原ResponseModel无headers，无法仅靠现有MCP实现双向同步。

**Inferred，凭据与预算验收**：私有原始文件使用0600、目录0700；Windows另验当前用户ACL，mode数字不能证明Windows隔离。默认MCP结果/日志脱敏，原文不进错误日志；关闭HTTP上游服务对外暴露；响应读取时实施解压后字节上限、总在飞字节额度，避免“先拿完整内容再截断”。本轮初始URL都经现有校验，follow_redirects=False，无调用方凭据；这不是对原MCP的DNS pin安全认证。

## 七、延迟实测数据

**Observed，五轮交替样本**：同一fixture首条URL、缓存关闭、请求预算60s、每次新HTTP会话；Node计时为fetchArticlePage（不含Readability），Scrapling计时为make_request(html/False)包含Python解析与MCP传输；两者都200。Python冷启动另计。网络条件与客户端头不同，不能外推所有站点均提速。

| 轮次 | Node static HTTP ms | Scrapling make_request ms | 状态 |
|---|---:|---:|---|
| 1 | 2272.5 | 1746.0 | 两者 200 |
| 2 | 2503.1 | 1090.0 | 两者 200 |
| 3 | 1364.2 | 1145.0 | 两者 200 |
| 4 | 1606.4 | 1175.6 | 两者 200 |
| 5 | 2276.5 | 1294.1 | 两者 200 |

**Observed**：中位数 Node **2272.5ms**，Scrapling **1175.6ms**，本URL下降 **48.3%**。计时wrapper只包裹原版make_request，不修改上游源码；五次页面MCP总耗时减去Python工具内部耗时的中位数 **22.85ms**，含IPC、MCP封装、调度和序列化；不能称纯pipe时间。每响应JSON约693160字节；28次同等负载估计 **639.7ms**，是乘法估计，不是28篇异尺寸页面的实测总IPC。空list_sessions 100次中位数 **1.375ms**、P95 **2.012ms**；冷启动本轮1.3–2.35s。原始值：[performance-5.json](performance-5.json)、[performance-summary.json](performance-summary.json)。

**Observed，28份实际响应的无网IPC回放**：先对每个URL重新captureUrl+公网校验，再用原26份HTML结果和2份错误模型作内存回放，仅测MCP传输/封装。28次RPC、总JSON载荷13891847字节，去除Python函数内部耗时后的累计开销 **262.06ms**、每次中位数 **6.49ms**。这是并发2的负载回放，不是28篇真实网络请求的全链路IPC分解；与首篇五轮22.85ms采用不同负载/调度，不能混作同一分布。见 [ipc-replay28.json](ipc-replay28.json)。

**Observed，单子进程并发**：相同16个fixture URL子集，排除O Tempo/BCB/Estadão，20s请求预算、禁重试、html/False；每档新起一个子进程，阶段内部16任务和参数相同。15个HTTP200、同一G1为403。它证明网络请求未被全局串行化，不证明16为生产最优并发。

| 并发 | 固定请求数 | 批次秒（不含启动，含关闭） | 同时在飞峰值 | HTTP 200 / 403 |
|---|---:|---:|---:|---|
| 2 | 16 | 19.728 | 2 | 15 / 1 |
| 8 | 16 | 9.427 | 8 | 15 / 1 |
| 16 | 16 | 4.970 | 16 | 15 / 1 |

**Observed，覆盖比局部速度更关键**：本轮N完整阶梯26/28；A主导24/28，O Tempo与Estadão在60s超时，MCP将原因压平。G1由Node成功变成Scrapling403，只由JS回退补救。B不支持BCB动态正文。N本次批量137.9s、A+B双投影实验242.0s；两批有交错网络负载，且后者每页两次HTTP，所以禁止用其比值比较端到端性能；原用户104s基线不改。

**Inferred**：局部提速和部分拒绝改善都存在；足以研究可选provider，不能支持默认主导。TLS纯因果仍属Assumed：需同出口、同headers/UA、同缓存、impersonate开/关四臂对照，排除HTTP头和路由变量。不是“换TLS必然解除所有403”。

## 八、迁移路径

| 阶段 | 交付/允许改动 | 独立验收 | 独立回滚 | 状态 |
|---|---|---|---|---|
| P0 证据 | 本报告、原始数据、源码审阅；无产品补丁 | 三最小实验、28篇、5轮、并发及故障注入已执行 | 删除新增reports和隔离venv，不影响产品 | DONE |
| P1 窄bridge | 可选Python provider：raw bytes/headers、固定地址、typed errors、单权威jar、读取预算、取消 | 下列安全/生命周期全通过，Node默认及240基线不变 | 删除provider模块和可选依赖文档 | NEXT，仅试点建议 |
| P2 明确选择 | 默认Node；仅配置允许的client失败可试TLS，再按原规则走browser；Node成功不重抓，decision不进入TLS试探 | 原26篇全保留、2短码不变；原403文章获得正文且无新门闸绕过 | 关闭可选provider配置，回到当前Node阶梯 | NEXT，P1通过后 |
| P3 有限发布 | 站点允许列表、状态诊断、响应原因/耗时/预算指标 | 同等输出的成功率/质量不退，P95和总成本满足明确目标 | 移除站点允许项/禁用provider | NEXT，P2通过后 |

**Inferred**：缺失依赖时，默认Node路径完全不启动Python；显式选择Scrapling且readiness失败则报provider-unavailable并显示原因，不静默更换provider，也不自动执行pip/uv下载、Python运行时或浏览器安装。重试阈值、启动/退出预算、并发、在飞字节上限都应由[src/config.js](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/config.js:6)解析的部署字段负责，不写死在插件内部。

## 九、成本清单

| 项目 | 成本与责任 | 标记 |
|---|---|---|
| 部署 | npm仍不能携带Python；管理员提供已有Python3.10+绝对路径与手工安装的隔离venv，固定Scrapling和全部传递依赖。A不需要执行scrapling install。 | Inferred方案；本轮venv约301.0MiB为Observed |
| Node依赖 | 复用已有@modelcontextprotocol/sdk client/stdio；不新增npm依赖。 | 用户给定事实，代码路径已使用 |
| Python依赖 | 仅钉Scrapling不足；本轮解析到curl_cffi0.16.3、Python MCP2.3.0等，后者的错误包装影响协议。保存完整冻结清单，升级由工具包maintainer负责回归。 | Observed |
| 浏览器 | A只做HTTP；C可以显式指向已有executable_path，缺失报不可用。源码不要求每次自动安装，但开启Cloudflare solver会点击验证，必须禁止。 | Observed [已有路径/solver](https://github.com/D4Vinci/Scrapling/blob/333fa22b7a5821194ce66b59b11f4b16a6484f02/scrapling/core/ai.py#L734-L789)、[点击行为](https://github.com/D4Vinci/Scrapling/blob/333fa22b7a5821194ce66b59b11f4b16a6484f02/scrapling/engines/_browsers/_stealth.py#L393-L480) |
| CI | 纯Node默认任务继续在无Python环境跑原240；Python opt-in独立Windows/Linux矩阵，覆盖typed errors、pin/redirect/proxy、会话、取消、child/parent崩溃及负载。 | Inferred，尚未实现 |
| 测试影响 | 可选provider且保留默认与注入：0项现有断言必须改（设计推断）；直接ResponseModel替换至少12项语义需新provider对等覆盖；B另涉及pipeline中15项抽取用例。没有替换补丁，不能编造“必然失败多少项”；旧mock仍全绿并不覆盖Python。 | Inferred，17测试已静态审阅 |
| 文档 | 实施时在toolkit README.md/README.zh.md写可选provider安装、readiness、配置、预算、安全和回滚；src/config.js+provider owner校验，status暴露脱敏结果；当前没有把未实现功能写成已支持。 | Inferred |
| 维护 | 工具包maintainer拥有Node/Python协议与依赖升级，发布负责人冻结包；人选/工时未确认。 | Assumed |
| vendoring | 不采纳当前源码拷入产品；它不消除Python/native wheels，反而增加SHA跟踪、补丁重放、许可证/安全修复成本；如将来采用必须指定owner和升级验收。 | Inferred；未vendoring |
| 其它候选 | 官方关联Node库[impers MIT许可证](https://github.com/lexiforest/impers/blob/b7bbb24ac29c6599db701bd614499dcbaa183b4b/LICENSE)是需单独核验的候选，尚未安装/验收；不能把“Node完全没有许可干净替代”当已证明前提。 | Observed许可证，运行可用性Assumed |

**Observed，12项精确验证位置**：test/retrieval.test.js 的83、92（编码），101、113、127（Retry-After/重试上限），146（跳转Set-Cookie），201、218、233、254（缓存），另171（static→browser cookie）、189（同字节JSON-LD）。这些测试使用request/fetchPage doubles，须对真实新provider重新绑定，不是删除现有断言。全部17文件分类在隔离目录source-audit.md。

**Assumed，后续需做的实验与责任**：下表是工程估计，不是承诺日期。

| 未验证事项 | 验证方法 | 预计投入 | 执行owner |
|---|---|---|---|
| TLS纯因果 | 相同UA/headers/出口，Node与curl指纹开关四臂；三个403站的实际文章URL与正文核对 | 1–2小时 | 工具包maintainer/测试工程师 |
| bridge安全与错误信息 | 固定地址、DNS重绑定、mixed IPv4/IPv6/DNS64、跨源跳转、代理环境、byte/解压上限反例 | 1–2工程日，需bridge实现 | provider实现owner |
| parent硬杀/无僵尸 | Windows Job Object及Linux进程组，父进程terminate、启动/取消竞争、exit/drain断言 | 1–2工程日 | provider owner及CI owner |
| renderer替换收益 | 若重开C，对已有二进制+solver=False做28篇双投影/质量/预算对照；不得自动下载 | 0.5–1工程日 | renderer owner |

## 十、Go / No-Go 判定与触发条件

**Inferred，当前 No-Go**：否决“Scrapling全面主导”及“原版scrapling-mcp直接作为生产HTTP替换”。依据为A成功26→24、B内容噪声/SPA丢失、HTTP元数据缺失、异常类型被压平、DNS pin不足，以及已复现的10MiB IPC超限。三站不是全403，故不是按第一道停止规则否决，而是后续质量和安全条件未达标。

**Inferred，有限 Go**：只准进入A可选provider的独立实现设计，保留现有抽取和renderer作为替代方案。生产Go前须同时满足：原28回归的26成功、2短错误不退；相同已捕获字节下正文段落/证据不增噪、不漏关键块；新增目标403文章确有可读正文；全部安全反例拒绝；typed错误覆盖五失败族；240 Node基线在无Python环境保留；新provider集成/崩溃/取消/父退出测试通过；有字节/并发/退出预算及单开关回滚。任何既有成功文章退步、登录/付费/验证码越界、公网策略退步或凭据泄漏均不可接受，不设置可容忍退步篇数。

**Observed，交付边界**：本轮没有接入或发布Scrapling，没有安装Python运行时或浏览器，没有引入Firecrawl/ai-crawler-helper，没有变更UI、MCP配置、package清单或现有测试；临时Python子进程关闭后未发现本实验残留python进程。原始响应仅在Temp隔离目录，默认不随npm分发。产品源码/测试/清单SHA256与实验开始快照一致，见evidence-manifest.json；本报告仅为可行性评审。
