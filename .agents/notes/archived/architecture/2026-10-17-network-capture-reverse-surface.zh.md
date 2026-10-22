# Agent Note: 把网络录制做成第一类逆向采集面

Status: implemented
Archived: 2026-10-23

[English](2026-10-17-network-capture-reverse-surface.md) | 中文

## Problem

工具包负责读取文章正文并保存配图方案。当一篇文章读不下来时，结果只是一个错误码（`article-extraction`、`article-restricted`、`article-render`），页面自身的网络行为没有留下任何痕迹。操作者若想弄清某页为何 HTML 里没有正文、或者哪个 JSON 端点才承载文章，只能跳出工具，在浏览器 devtools 里手工复现一次加载。

渲染器本来就把每个请求交给自有的、地址固定的传输层，它看到的交换正是逆向视图需要的那些。本次改动之前，这些交换在路由完成后就被丢弃了。

## Decision

把网络交换的录制、清单、重放与导出做成独立工具族，不改动既有 11 个工具的契约，也不改 `state.json` schema。

| 模块 | 职责 |
| --- | --- |
| `src/har.js` | HAR 1.2 构建/解析，请求头与请求体的凭据脱敏 |
| `src/endpoints.js` | URL 模板化、端点清单、追踪器分类 |
| `src/recorder.js` | 私有捕获存储、原子发布、HAR 导入导出 |
| `src/replay.js` | 基于覆盖参数的重放，走固定传输层 |

新增六个工具：`capture_record`、`capture_endpoints`、`capture_exchange`、`capture_replay`、`har_export`、`har_import`。渲染器新增两个选项——`onExchange` 与 `markup`——使一次录制不依赖正文抽取成功。

### 凭据边界

工具输出默认脱敏；`reveal: true` 是每次调用显式开启的开关。原始值只存在于 `<dataDir>/captures/<id>/raw/NNNNN.json`（0700 目录树内的 0600 文件）。脱敏覆盖请求头与响应头、按键名后缀判定的 JSON 字段，以及逐字段处理的表单编码体，因此录到的登录 POST 不会回显密码。端点摘要只带 cookie 名称、数量、认证方案与长度。

### 重放目标校验

若捕获是在测试策略下录制的，它可能包含 loopback 或私网地址。因此重放对每个目标重新执行 `captureUrl` 与公网策略，并把调用方提供的头限制在非凭据元数据范围内。凭据只能来自录制，`credentials: 'omit'` 会丢弃它们。

### 写请求

渲染器只应答 GET 与 HEAD。页面的登录 POST 会以 `sent: false` 与 `blocked: article-resource-method` 记录，而不是静默丢弃，因为这类请求恰恰是逆向任务里信息量最大的端点。

## Alternatives considered

**嵌入 `har-skills` 的 HAR 实现。** 它是 Go CLI（MIT），采用它等于给现有 Node 工具包加上二进制与语言运行时。HAR 1.2 是开放规范，原生实现构建与解析只有几百行，且导出的文件仍可与该工具互操作。

**把富内容块模型挂到既有 `article_image_article` 上。** 该工具的段落契约与 `state.json` schema:1 已被保存的方案与审核消费。改动它会为一项增量能力引入迁移；独立工具让两套契约都保持稳定。

**把捕获存进 `state.json`。** 捕获内容可能超过状态字节预算；`state.json` 在每次保存方案时整体重写。独立私有目录加原子重命名，与既有 `capture-sources` 布局一致；重放追加记录，并只更新捕获索引。

**在本阶段做自适应元素重定位。** 它是另一项真正缺失的能力，但需要先有录制面才能验证。它属于后续阶段，不构成本阶段的阻塞项。

## Retrieval stability

录制面让页面的网络行为可查，但并不会让读取本身更容易成功。有三个事实决定页面到底能不能读，而此前它们没有归属：

| 模块 | 职责 |
| --- | --- |
| `src/decode.js` | 字符集协商：BOM、响应头、`<meta>`、合法 UTF-8，最后是字节特征 |
| `src/session.js` | per-origin cookie jar，静态抓取、渲染器与录制浏览器共用 |
| `src/pacing.js` | 每主机令牌桶、`Retry-After`（秒数或 HTTP 日期）、主机级阻塞 |
| `src/pipeline.js` | 静态 → 结构化 → 浏览器的策略阶梯，按失败族排序 |

### 用失败族取代错误码白名单

原先的升级规则是一份硬编码的错误码集合（`RENDERABLE`），只回答「哪些失败我愿意为它付一次浏览器开销」，却不回答真正唯一重要的问题：「换浏览器会不会改变结果」。现在失败按族分类：

- `content`：文档到了，但文本需要脚本执行才有。先 `structured`（用同一份字节读 JSON-LD 的 `articleBody`），再 `browser`。
- `client`：服务器拒绝的是这个客户端，典型是面对非浏览器 UA 的 403。直达 `browser`；`structured` 重读的正是服务器已经拒绝过的字节。
- `decision`：服务器就访问权或存在性给出了答复（404、429、5xx、登录墙、付费墙）。浏览器会拿到同一答复，因此阶梯在此结束，原错误码保留。
- `transport`：文档根本没到。渲染会重走同一条网络路径；此时应上调超时。

升级时向前扫描第一个失败族匹配的层级，中间层因此不构成咽喉。未登记的错误码默认归入 `transport`：没人分类过的失败，不能以「渲染也许有用」为理由触发一次昂贵的浏览器启动。

`size` 族也会升级到浏览器：渲染器独立请求文档，并在序列化前剪枝，同时仍执行自身的下载和输出上限。实际分类以 `src/pipeline.js` 为准。

### 字符集

已声明的编码优先且不再重新打分；只有什么都没声明、且 UTF-8 解码失败时才进入字节特征这一级。它在固定而有序的候选集（`gb18030`、`big5`、`shift_jis`、`euc-kr`、`windows-1252`）上按「CJK 密度减去解码损伤」打分，因此没有声明编码的 GBK 文章会被读成文本，而不是一片替换字符。`gbk`/`gb2312` 归一为 `gb18030`，因为后者是超集；`latin1`/`iso-8859-1` 归一为 `windows-1252`，因为浏览器实际按后者解码。

### 会话与跳转

一个 jar 贯穿静态抓取、渲染器与录制浏览器，因此静态阶段站点写下的 cookie，在同一 URL 进入渲染时已经带上。cookie 遵循 RFC 6265 的主机、域与路径规则；违反 `__Host-`/`__Secure-` 前缀约定的整条丢弃而不是照发；`Domain` 指向公共后缀的请求被拒绝，以免一个站点的会话泄露给共用 `com.br` 或 `co.uk` 的所有站点。

固定传输层在内部跟随同源跳转，此前只返回最终响应头，跳转过程中的 `Set-Cookie` 因此被丢弃。于是「先 302 到正文、同时下发会话」这类门闸会丢掉会话，正文被读成 403。现在每一跳的 cookie 都累积并随最终响应返回；401/403 若同时下发了 cookie，则带该 cookie 重试一次。

### 限速

每个主机各有令牌桶（`hostRatePerSecond`、`hostBurst`）；遇到 429，或带 `Retry-After` 的 503，该主机按服务器给出的时长阻塞（上限 `maxRetryAfterMs`），请求重试一次。第二次仍被拒就原样返回，不把等待放大成重试风暴，其他主机照常进行。桶按主机划分，因为一个慢站点不应拖住其他站点的读取。

## Verification

确定性覆盖位于 `article-image-toolkit/test/record-replay.test.js`、`session.test.js`、`decode.test.js`、`pacing.test.js` 和 `pipeline.test.js`。以下真实来源目标保留原始验收标准；离线测试通过不能证明 Folha 交换数量目标或公开站点当前可达。

- 以 `scope=api` 录制 folha 样例文章，至少得到 15 条交换与 8 个端点，其中至少 5 个是站点自有而非追踪器。
- 任何默认工具读取都不含 bearer 令牌或原始 cookie 值；`reveal: true` 返回它们。
- 改动查询参数的重放返回 200，并向同一捕获追加一条记录。
- 导出后再导入，交换数与端点数保持一致。
- 生产策略下，录到的 loopback 目标以 `article-url-blocked` 被拒。
- 条目预算截断时报告 `dropped` 而不是失败。
- 既有 11 个工具保持原 schema 与行为。

读取稳定性：

- 只在 `<meta>` 里声明字符集的 GBK 页面能无替换字符地解码；完全不声明编码的同样可以。
- 带 `Retry-After` 的 429 重试一次后成功；不带该头的 503 不重试；第二次仍被拒则原样返回。
- 跳转过程中的 `Set-Cookie` 会进入 jar，且同一 cookie 在该页渲染时送达浏览器。
- 同时下发会话 cookie 的 403 会带该 cookie 重试一次。
- 付费墙、登录墙、404 与 429 绝不启动浏览器；403 会。

## Consequences

- 追踪器主机列表是静态启发式。若某站点用自己的同名 CDN 主机承载 API，会被判为追踪器；`owner: 'all'` 仍能取到它。
- `recordScope: 'api'` 保留文档、XHR、fetch 与 WebSocket。若站点通过该集合之外的资源类型下发文章数据——例如 EventSource 流——需要改用 `all`。
- 原始捕获文件按设计保存明文凭据。控制手段是目录权限与默认脱敏；用户若把 `raw/` 复制到别处，就失去了这层控制。
- HAR 导出会把原始头值写入磁盘。工具描述已说明这一点，但导出文件本身就是带凭据的产物。
