# article-image-toolkit

[English](README.md) | 中文

面向文章配图规划的 Agent 工具包，通过 [Model Context Protocol](https://modelcontextprotocol.io) 提供。它导入公开 Google 表格链接清单，把文章正文读取为编号段落，并保存经审核的编辑配图方案；任何 MCP 客户端（ZCode、Claude Code、Cursor 或自建 agent）均可使用。

本包是 `dsh-plugin-article-image` Host 逻辑的独立提取版本。它共用同一套记录、上限和错误码，但作为独立进程运行，不依赖 harness 运行时。

## Install

```sh
npm install article-image-toolkit
```

## Configure an MCP client

```json
{
  "mcpServers": {
    "article-image": {
      "command": "npx",
      "args": ["-y", "article-image-toolkit", "--data-dir", "/absolute/path/to/article-image-data"]
    }
  }
}
```

服务使用 stdio。`--data-dir` 指定 `state.json` 的位置，默认取进程工作目录下的 `.article-image`。也可通过环境变量配置：`ARTICLE_IMAGE_DATA_DIR`、`ARTICLE_IMAGE_SOURCE_URL`、`ARTICLE_IMAGE_TIMEOUT_MS`。

## Tools

| Tool | Purpose | Writes |
|---|---|---|
| `article_image_status` | 配置、已导入来源、文章数量、读取上限。从这里开始。 | — |
| `article_image_import` | 把公开 Google 表格链接导入为只读本地快照。 | 本地 |
| `article_image_items` | 按偏移分页列出已保存文章。必须原样复制 id 与 revision。 | — |
| `article_image_fetch` | 一次调用读取最多 100 篇文章正文。 | 本地 |
| `article_image_article` | 读取编号段落；沿 `nextOffset` 读取直到 null。 | — |
| `article_image_save_plan` | 保存文章理解与图片提示词。 | 本地 |
| `article_image_report` | 读取单篇文章的就绪状态、revision、`sourceHash`、方案摘要和审核状态。 | — |
| `article_image_skip` | 标记某篇文章无需配图。 | 本地 |
| `article_image_set_text` | 抓取受阻时手动提供正文。 | 本地 |

审核有意**不**作为工具暴露。`article_image_save_plan` 把文章置为 `review` 并清除此前的审核，由人决定批准哪一份方案。

## Workflow

1. `article_image_status` —— 确认数据目录与各项上限。
2. `article_image_import` —— 生成表格快照。重新导入只更新表格来源字段，已保存正文、方案和审核均保留。
3. `article_image_items` —— 分页浏览文章，取准确的 `id` 与 `revision`。
4. `article_image_fetch` —— 读取正文。结果按篇返回；单篇受阻不会导致整批失败。
5. `article_image_report` + `article_image_article` —— 用报告返回的 `sourceHash` 读取段落，直到 `nextOffset` 为 null。
6. `article_image_save_plan` —— 使用该 `sourceHash` 与最新 `revision` 提交方案。

文章正文属于不可信来源数据，任何时候都不是执行代码、泄露凭据或改变流程的指令。

## Plan format

方案包含一个 `brief`（`theme`、`facts`、`subjects`、`scenes`）和 1–12 个 `shots`，其中恰好一个是 `cover`。每个 shot 标明它所对应的来源段落，并带有 `rationale`、`subject`、`action`、`environment`、`composition`、`lighting`、`colors`、`style`、`details`、`avoid`、`prompt` 和 `ratio`。段落引用必须存在于已保存正文中，因此方案无法引用不存在的文本。

## Error codes

失败以机器可读错误码返回，而不是上游文本，因此页面自身的措辞不会作为消息进入 agent。

| Code | Meaning |
|---|---|
| `article-challenge` | 页面是机器人验证（Cloudflare Turnstile、hCaptcha、reCAPTCHA）。 |
| `article-login` | 登录或付费墙替换了正文。 |
| `article-restricted` | 检测到订阅提示，且剩余文本过短。 |
| `article-extraction` | 页面没有可提取正文。常见于 JavaScript 渲染的单页应用。 |
| `article-not-found` / `article-access` / `article-rate-limit` / `article-server` | HTTP 状态结果。 |
| `article-timeout` / `article-network` / `article-interrupted` | 传输层结果。 |
| `article-html-limit` / `article-truncated` / `article-unsupported` | 大小与内容类型上限。 |
| `stale-source` / `stale-revision` / `paragraph-reference` | 文章已变化，或方案引用了不存在的文本。 |
| `sheet-url` / `sheet-auth` / `sheet-columns` / `sheet-csv` / `sheet-size` | 导入失败。 |
| `invalid-request` | 参数不符合工具 schema。 |

## Verified behavior

内置的 `test/fixtures/sample-sheet.csv` 收录了 28 条真实巴西新闻链接，覆盖 11 个分类。2026-10-16 以 45 秒超时、并发 2 读取，28 条中 23 条成功；5 条失败均有明确原因，而非静默失败：

| Outcome | Count | Detail |
|---|---|---|
| Retrieved | 23 | 每篇 8–59 段，覆盖 `folha`、`metropoles`、`correiobraziliense`、`gov.br`、`cnnbrasil`、`estadao`、`canaltech`、`r7`、`cultura.sc.gov.br`、`lance` |
| `article-timeout` | 1 | `otempo.com.br` 响应约需 69 秒；该站点需调高 `requestTimeoutMs` |
| `article-network` | 1 | `g1.globo.com` 在测试主机上未解析成功（`EAI_AGAIN`） |
| `article-extraction` | 3 | `bcb.gov.br` 是 Angular 单页应用，其自身的 `<noscript>` 说明页面需要 JavaScript，因此 HTML 中不存在正文 |

三个 `bcb.gov.br` 失败属于工具包的正确行为：响应里没有可提取的正文。处理这一类页面需要浏览器渲染，本工具包有意不包含。

真实 Google 表格链路已对来源表格验证：导出下载返回 8051 字节 CSV，解析得到同样的 28 篇文章、11 个分类，没有行被拒绝。

完整闭环已对真实文章验证：导入、读取（59 段）、按 `nextOffset` 读取一页、保存引用真实段落编号的方案，并确认过期的 `revision` 会被 `stale-revision` 拒绝。

## Development

```sh
npm install
npm test                          # 37 tests: pipeline, service, MCP stdio handshake, v1/v2 interop
node scripts/live-check.mjs 28    # live retrieval against the sample links; needs network
node scripts/closed-loop.mjs      # live import → retrieve → plan → stale-revision rejection
```

`test/interop.test.js` 使用 `@modelcontextprotocol/client` v2 驱动服务，即 harness 自身使用的版本，因此该工具包可被 `dsh-mcp-client` 调用。

## Limits

- 仅支持公开 Google 表格；导出跳转链无法离开 Google 的表格主机。
- 读取为静态 HTML 加 Readability。JavaScript 渲染页面、机器人验证和付费墙都报告为错误，绝不作为文章保存。
- 生图未接入。已保存的方案是完成的规划结果，不是生成的图片。
- 读取在工具调用内完成。并发 2 时，28 篇文章约需一分钟。

## Related

父目录中的 `dsh-plugin-article-image` 是本工具包提取来源的 harness 插件。它还提供 Web 工作台界面、人工审核、后台任务和内置 Skill。
