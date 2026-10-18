---
kind: upgrade-guide
description: "文章生图处理采用富文本浏览器快照、明确分析模型与独立 profile 索引。"
---

# 文章生图流程与 profile 记录

[English](guide.md) | 中文

## 变更

文章生图组合包通过 `article-image-toolkit/capture` 获取富文本和原图，然后启动专用分析会话。开始处理不再表示抓取纯文本后手动复制到聊天。需要明确配置分析提供方/模型及可用 Chromium。未知站点模板需要核对来源；已知缺失阻止分析。人工审核仍是终点，不连接生图或发布。

profile 记录采用 `state.v2.json` 和不可变素材集合。原 `state.json` 保持不变，并在 `legacy/` 下保留摘要命名副本。旧正文、方案和审核作为历史可读，但不能批准新的富文本方案。原生 `article_image_save_plan` 接受结构化分析结果；旧方案返回 `legacy-needs-refetch`。独立 toolkit MCP 保留分离的 schema:1 文本流程。

## 迁移

工作台进度记录包含安全的根因字段及图片下载/解码耗时。严格校验诊断字段的早期 schema:2 读取器可能拒绝这些字段；降级时必须恢复升级前的完整 profile 备份。新增可选控制项为 `progressBatchSize`、`progressFlushMs`、`capture.imageConnectionPoolSize` 和 `capture.maxImageTransportRetries`（默认1，范围0–2）；采用默认值无需修改 patch。连接池大小设为0可关闭篇级原图连接复用，请求预算和公网校验仍保留。

站点适配器可选择配置 `captionSources` 和精确 HTTPS `imageRedirects`，省略时均不启用。`capture.maxCaptionCues` 默认2000。降级到严格校验配置的旧读取器时，须先从 profile patch 移除这些可选字段。字幕文字计入来源哈希，需重新获取并完成来源与方案审核，既有批准不批准新增字幕。

浏览器连接复用使用 `capture.rendererConnectionPoolSize`（默认8；0关闭复用）及 `capture.rendererConnectionsPerOrigin`（默认4）。适配器的可选 `browserResources.deferTypes` 和 `static` 需要验证发布站，省略时保留完整浏览器加载。同一主机上的模板专用规则使用适配器 `pathPrefixes` 限定路径。可选 `capture.imageMetadataSources`（默认 `[]`）从已核对文章身份的发布站元数据补全空图片说明，采用说明后需要重新审核来源及方案。安全及完整性条件见[提取参考](../../../../custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/README.zh.md#shared-rich-capture-api)。降级到严格校验配置的旧读取器前，须移除两项渲染设置、包括 `pathPrefixes` 的这些适配器字段及 `imageMetadataSources`。

1. 停止插件，保留 `$DSH_HOME/.plugins/dsh-plugin-article-image/profiles/` 下完整 profile 数据目录。
2. 安装组合包和 toolkit 两个生产包。在 `article-image` Cordis 行将 `analysis.provider`、`analysis.model` 设置为已配置 DSH 路由；有图文章需要视觉输入和附件服务。按[包参考](../../../../custom-plugins/workspace/dsh-plugin-article-image/README.zh.md)检查限制及站点适配器。
3. 打开工作台检查浏览器/模型就绪状态。重抓旧记录，核对不确定的正文范围，确认理解稿和提示词进入 `review` 后再批准。保留的旧审核不批准新方案。
4. 回退时停止插件并保留新数据目录，让旧包使用未修改的 `state.json` 或 `legacy/` 副本。不要将 `state.v2.json` 改名为 `state.json`，旧包不能读取该格式。
