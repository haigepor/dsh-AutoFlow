# 全球新闻工具包原图与网络修复复测

本地日期：2026-10-18（Asia/Shanghai）。原 16 条 URL 不变，真实 MCP stdio 调用，文本与富文本各并发 2；单请求 60 秒，渲染 120 秒，调用 180 秒。缓存关闭，独立临时数据目录，模型与真实生图均未接入。

正文返回 15/16，富文本返回 13/16；返回不代表全文验收。富文本自动通过 0/16；News24 独立复核恢复，详见复核表；未知正文范围、信息图等继续保留 partial/needs-review。

## 同链接逐站结果

| 站点 | 编号正文 | 富文本段落与已解码资产 | 富文本质量 | 耗时：正文/富文本（秒） |
|---|---|---|---|---|
| CBS News | 45 段 | 38 段 / 6 图 / 失败 0 | partial | 4.337 / 24.971 |
| 新华社 | 38 段 | 38 段 / 0 图 / 失败 0 | needs-review | 2.661 / 14.153 |
| Associated Press | 16 段 | 20 段 / 1 图 / 失败 0 | partial | 12.115 / 27.142 |
| France 24 | 20 段 | 30 段 / 3 图 / 失败 0 | partial | 7.529 / 13.564 |
| CNA | 31 段 | 51 段 / 16 图 / 失败 0 | partial | 5.804 / 41.411 |
| ABC Australia | 33 段 | 29 段 / 6 图 / 失败 0 | needs-review | 2.863 / 30.256 |
| Al Jazeera | 25 段 | 31 段 / 2 图 / 失败 0 | partial | 2.116 / 18.908 |
| DW | 44 段 | 17 段 / 4 图 / 失败 0 | partial | 3.878 / 19.679 |
| EL PAÍS | 14 段 | 28 段 / 2 图 / 失败 0 | partial | 7.817 / 18.555 |
| Folha de S.Paulo | 59 段 | article-restricted | 拒绝 | 8.463 / 48.896 |
| News24 | 26 段 | article-network | 拒绝 | 7.167 / 5.2 |
| South China Morning Post | article-restricted | article-network | 拒绝 | 5.281 / 4.84 |
| NPR | 28 段 | 33 段 / 4 图 / 失败 0 | partial | 3.047 / 61.103 |
| The Guardian | 12 段 | 17 段 / 0 图 / 失败 0 | partial | 5.053 / 19.666 |
| BBC News | 85 段 | 60 段 / 7 图 / 失败 0 | needs-review | 2.557 / 18.096 |
| CNN | 354 段 | 354 段 / 0 图 / 失败 0 | partial | 8.179 / 24.114 |

## 网络失败的独立复核

首轮 13/16 不改写。对两个 article-network 使用相同源码、URL 和预算另开隔离 MCP 会话：

| 站点 | 首轮 | 独立复核 |
|---|---|---|
| News24 | article-network | 返回 24 段 / 0 图，partial（28.928 秒） |
| South China Morning Post | article-network | article-restricted（4.654 秒） |

结合复核，14 个站点至少返回一次富文本；不能写成首轮 14/16，也不能据此认证完整性。News24 的网络波动仍是运行限制；两个失败记录与复核原样保留于 rich-results.json、recheck-results.json。SCMP 的正文限制并未解除。

## 原图修复证据

NPR 的 DIMS 缩放服务此前返回 403；候选现在使用页面公开的 DIMS url 参数所指原文件，仍逐次做公网校验。AP 的正文主图在 Readability 投影中丢失；仅恢复当前文章 JSON-LD 声明、且正文 DOM 中可见的匹配图片。禁止任意 query 解包或抓推荐图补数。

| 站点 | 状态 | 尺寸 | 字节 | SHA-256 |
|---|---|---|---|---|
| Associated Press | ready | 6048×4024 | 4953168 | ae216e803128cfae763c113adbd4b05b46949eec7d427b0c924011c3975cc21b |
| NPR | ready | 3968×2653 | 919872 | 4b60b60c3a36abf448ca81555b3fe613a420095c2b8aed5ed74925a514bab6ad |
| NPR | ready | 100×100 | 14232 | 65ff28ba7c0b85482bfeee5c61badac3fdc3cbb20ab33fc4a44838bc98da11d5 |
| NPR | ready | 1872×1542 | 1974374 | f6192ddb209d45955271a28383aa3785b61b7d67bfbc3dcb6d49be160e9d2449 |
| NPR | ready | 3072×2048 | 2541931 | ea1213d0d921019f90bef2ac20fc7bfc8dca2e5e8dfc2ec11322ae19c4d655a6 |

所有 ready 资产均从真实磁盘文件核对长度与 SHA-256，随后核对 MCP 分页/分片重建与持久化快照、语义 hash 一致。图片总数中可能包含原先已有的缩略图；NPR 的 100×100 旧缩略图与三张恢复原图分开列示。

## 不退步核对

| 站点 | 旧/新编号段落 | 编号正文哈希一致 |
|---|---|---|
| CBS News | 45/45 | 是 |
| 新华社 | 38/38 | 是 |
| Associated Press | 16/16 | 是 |
| France 24 | 20/20 | 是 |
| Folha de S.Paulo | 59/59 | 是 |
| NPR | 28/28 | 是 |
| CNN | 354/354 | 是 |

| 站点 | 旧/新富文本段落 | 旧非空块保留 | 旧图片哈希保留 |
|---|---|---|---|
| CBS News | 38/38 | 40/40 | 6/6 |
| 新华社 | 38/38 | 38/38 | 0/0 |
| Associated Press | 18/20 | 17/17 | 0/0 |
| France 24 | 30/30 | 32/32 | 0/3 |
| NPR | 33/33 | 39/39 | 1/1 |
| CNN | 354/354 | 354/354 | 0/0 |

CBS 的 6 张旧图与 NPR 的 1 张旧缩略图字节哈希一致。France 24 当前 DOM 提供同一发布路径标识的 WebP 版本，旧图为 JPEG：3 张尺寸分别一致，但字节哈希不一致；不宣称这 3 张图逐字节保留，详见 image-variant-comparison.json。新增 Accept 导致的 CBS 编码变化已消除，图片维持默认协商。

富文本的动态广告和空白块会随真实页面加载变化；哈希不得用于把不同图片或新增信息合并为同一证据。正文哈希逐篇列在 preservation.json。

## 修复位置与原因

- src/capture.js、src/declared-images.js：原图候选及声明图片恢复；排除推荐区域 article、收窄整页 main-role 包装；排除显式广告类及 Primis 广告包装。
- src/capture-media.js：取消检查先于启动 DNS/策略 Promise，避免已取消操作产生无人处理的拒绝而退出 MCP；图片保留状态/MIME 诊断，使用限域匿名 Cookie、默认 Accept 与 origin Referer。
- src/network.js、src/network-config.js、src/config.js、bin/article-image-toolkit.js：显式代理及 DoH。原有 Node 直连没有使用本机已配置的代理，国际站点部分 DNS/网络失败。代理 CONNECT 连接已验证的公网 IP，保留 Host/SNI 与证书校验，不交给代理重新解析目标。
- src/articles.js、src/capture-renderer.js：订阅声明加独立可见付费墙占位判为 article-restricted；在脚本隐藏证据之前检查主文档。正文承载容器与隐藏模板保持原处理。SCMP 不能当作全文成功。
- src/diagnostics.js：限长 MIME 安全字段，不暴露 Cookie、请求头、签名路径与正文。
- test/ 与 README 中英配对：新增回归案例、配置与限制说明；依赖锁定 https-proxy-agent 9.1.0（MIT），及其 agent-base / proxy-agent-negotiate（MIT）；无 Python 或浏览器自动安装。

代码定位：[原图候选](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture.js:93)、[声明图片恢复](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/declared-images.js:48)、[取消前置检查](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-media.js:14)、[公网 IP 的代理连接](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-media.js:112)、[DoH 校验](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/network.js:10)、[付费声明检测](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/articles.js:160)、[渲染前的访问决定](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-renderer.js:149)、[广告过滤](C:/Users/haige/Desktop/deepseek-harness-master/custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture.js:160)。

## 部署启用

网络改善以显式启用为前提；在工具包目录运行本地源码版本：

```sh
node bin/article-image-toolkit.js --proxy-url http://127.0.0.1:7897 --dns-provider cloudflare
```

端口为本机已有代理，仅是示例。生产使用实际端点；独立调用 createCapture 时将 network 传给 resolveCaptureConfig。默认直连和系统 DNS 保持不变，不修改操作系统代理，也不自动继承环境代理。未修改父插件或 Web 的运行配置；这些消费者需要显式传入 network 后才能获得此网络修复。

## 验证与限制

工具包 320 项 / 23 文件通过；独立临时目录 npm ci --ignore-scripts --no-audit --no-fund 成功，安装后核心模块导入与配置冒烟通过；src/bin/test 的 JavaScript 通过 node --check；父插件相关 40 项 / 3 文件通过；README 中英配对检查通过。覆盖取消、代理 CONNECT 公网固定、重绑定/私网与跨源跳转拒绝、代理取消收尾、DoH 响应和缓存限额、DIMS 候选、AP 声明图片恢复与限制决定。完整 MCP 批次 stderr 在本目录保留。

网络连接有波动，早期验收批次 CNN 曾 article-network，独立复核恢复；不把重试抹成首轮成功。EL PAÍS 早期富文本有 403，后续完整批次恢复。保留 HTTP 决定，不为提高成功数绕登录、付费或验证码。新闻站 footer、视频及自适应页面仍需站点适配器和人工语义验收，本轮不宣布通用全文完成率。

## 修改与回滚

本轮改动与新文件精确列于 scope.json；开始时已有 206 个修改/未跟踪文件，189 个原样保留。范围外变化：0；测试后源文件漂移：0；编码问题：0。不执行 reset、restore、stash 或提交。

本轮修改前备份：`C:/Users/haige/AppData/Local/Temp/news-assets-network-zwYxri/before`（包含此前未提交实现）；回滚仅恢复 scope.json 列出的本轮文件，新建文件仅按该清单移除，不做整库恢复。报告和原始测试数据保留作为验收记录。

## 交付状态

- DONE：NPR 三张原图 403 回退、AP 正文主图恢复与广告图排除、取消导致 MCP 退出、旧 7 篇编号正文哈希与旧 6 篇富文本非空块保留。
- DONE：同 16 条真实 MCP 首轮复测、网络失败独立复核、320 项工具包与 40 项父插件测试、源码与修改范围核对。
- NEXT：为未知站点补充正文尾部与信息图适配并做人工语义验收；网络偶发失败仍需部署链路诊断。

没有连接真实生图，没有修改 Web 或父插件的运行配置。
