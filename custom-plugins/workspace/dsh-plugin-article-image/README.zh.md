---
description: "导入公开文章，理解正文与原图，并人工审核编辑配图提示词。"
kind: "package-bundle"
---

# 文章生图

[English](README.md) | 中文

## Summary

这个独立组合包从公开 Google 表格导入链接，通过 Chromium 获取富文本与原图，使用隔离的 DSH 会话准备理解稿和配图提示词。人工审核是流程终点。生图、远端素材发布、文章发布、表格回写、OAuth 和定时执行均不可用。

## Installation and development

CLI 为新 Web/Desktop profile 内置此包；已有 profile 保留原选择。生产依赖 `article-image-toolkit` 提供共享提取内核。运行 `pnpm --filter dsh-plugin-article-image build:client` 构建，`pnpm --filter dsh-plugin-article-image test` 测试，`pnpm --filter dsh-plugin-article-image check` 检查语法、入口、语言键和 UTF-8。

## Workflow

使用链接、分类、语言和备注映射导入公开 Google 表格。导入保持只读，仅在明确操作时应用远端变化，保留查询参数并在同表格/工作表内去重。采用的分类、语言或备注变化会使审核失效并停止旧输入的活跃分析；只移动行号不使审核失效。

开始处理单篇或批次。浏览器保留标题层级、强调、安全链接、列表、引用、表格、图片、图注和署名的顺序，剔除页面附属内容。原图字节单独保存。内联栅格图同样解码、限额并保存，不把 Base64 写入快照。质量检查显示缺图、不支持内容、分页不完整及范围疑点。未知范围需要明确核对；已知缺失不能通过人工确认消除。浏览器失败不会静默退回文本并声称完整。

合格内容自动进入理解、按需章节综合、规划和结构检查，无需复制到聊天。所有正文块和原图均需覆盖；有图文章要求模型支持图像输入。来源引用关联理解稿、配图卡片和阅读区。按内容重新规划配图，不逐张替换原图。

核对理解稿并编辑卡片。默认一张封面、两张正文图、16:9，中文说明和自足的英文提示词。新分析前选择数量和比例。场景或理解简报变化后，必须明确确认受影响提示词已更新。保存清除审核。过期版本、来源、采用的业务字段和未同步提示词不能通过，批准不会提交生图请求。

内容未就绪时沿用原版文章插画，分析期间仍可阅读已获取正文。停止和恢复使用现有操作栏。正文、理解与提示词、审核结果及运行诊断使用独立标签。在运行诊断页查看当前阶段和耗时，切换“运行日志 / Debug 数据”查看持久事件，或复制诊断 JSON。暂时读取失败时保留已加载内容，不显示全宽红条；Debug 保留有界错误码，通过刷新重试。首次加载失败仍提供重试。每次尝试最多保留 `maxRunEvents` 条事件（默认 80）；历史记录无法补录日志。诊断仅包含错误码、来源域、耗时与数量，不含 URL 路径/查询参数、凭证或正文。关闭页面仅停止订阅。停止会取消浏览器/模型并等待本地清理。明确恢复复用冻结输入及已提交检查点；Host 丢失显示中断，不自动调用模型。轮询保留草稿；离开未保存编辑需要确认。支持主题 token、窄屏、键盘及减少动态效果。插画见[素材说明](assets/README.zh.md)。

## Configuration and records

根 Cordis 行校验 [config-schema.js](config-schema.js) 中的限制。明确将 `analysis.provider` 和 `analysis.model` 设置为已配置的 DSH 路由。token/上下文/图片预算、超时、步数和并发均经过校验。运行时服务、模型/视觉能力或规则文件缺失会阻止分析。`maxAssetBytes` 继续用于本地资产上限；`capture.maxImageBytes` 控制抓取。

在根 article-image 行设置 `network.proxyUrl` 与 `network.dnsProvider: cloudflare`，让浏览器导航、数据资源与原图使用已有的 HTTP(S) CONNECT 代理及 DNS over HTTPS。例如 `network: { proxyUrl: "http://127.0.0.1:7897", dnsProvider: "cloudflare" }`，端点填写部署环境的实际值。富文本抓取继承该已校验配置，显式提供 `capture.network` 时除外。默认直连并使用系统 DNS；拒绝代理凭据，继续执行公网 IP 固定与跳转检查。编辑 profile 时保留已有分析设置及站点适配规则。表格导入与模型提供方使用各自的传输配置。上限见[工具包网络选项](article-image-toolkit/README.zh.md#explicit-network-routing)。

`capture.adapters` 用 `id`、精确 `hosts`、`articleSelector` 及可选 `endSelector`、`excludeSelector`、`pendingSelector`、`expectedMinImages` 声明站点模板。排除规则仅在访问检查后作用于正文内部；滚动后的加载占位等待共用渲染超时。可选 `pagination` 通过稳定元素属性识别同文分页；可选 `expandSelector` 仅允许正文只读展开控件。未匹配站点需要核对范围。生产导航、跳转和资源请求拒绝私有/本机地址。隔离上下文不复用登录 profile。浏览器就绪与安装插件分别管理。

编辑指令共用 [Skill references](skills/article-image-editorial-prompts/references/understanding.md) 和[运行时规则](rules)。`analysis.rulesFile` 可指定绝对路径的 UTF-8 JSON，含 `version: 1` 与部分 `policy`。包默认值、文件、单次数量/比例按顺序决定有效规则。每次任务冻结文件、哈希、策略、模板、模型设置、业务字段、正文块与实际图像附件。改动用于新任务；当前规则差异在保存输入旁显示。

数据位于 `$DSH_HOME/.plugins/dsh-plugin-article-image/profiles/<profile-path-hash>/`。`state.v2.json` 为轻量索引；不可变快照、输入、理解、方案及按内容寻址的原图字节分开保存。原子发布、摘要校验和跨进程写入锁保护记录。旧 `state.json` 保持原样，发布通过校验的后继文件前备份到 `legacy/state.v1.<digest>.json`。历史正文/方案/审核仍可读，但必须重抓后才允许新审核。手动文本保留为旧格式草稿，不能据此声称原图完整。

列表轮询只读取一次索引，并加载摘要所需的快照和方案字段。同实例写入先排队，再获取跨进程锁。抓取进度按 `progressBatchSize`（默认16，范围1–200）及 `progressFlushMs`（默认200毫秒，范围10–3000）分批提交；发布终态前等待剩余事件保存，保留事件实际发生时间。进度写入失败会取消抓取。诊断保留操作、安全的原因分类和异常类型，包含文件系统错误及写锁超时，不复制上游异常消息或路径。若终态索引也无法写入，后台任务结果仍保留安全诊断。

## Model Experience

原生工具提供状态、导入、处理任务、段落分页投影、方案 JSON 分页、保存及报告，不提供批准或生图工具。编辑已有方案需读取相同 `inputHash` 和版本的全部 `article_image_plan_page` 片段，按 Unicode 码点文本连接，再以该精确版本保存完整结构化方案。收集 `job_output` 后检查报告；任务句柄或 Agent 空闲不能代表方案提交完成。工具结果及原图附件进入持久 Session 输入。每个后台阶段只允许本任务绑定的提交工具。来源文本、图片和备注不能启用 shell、发布或批准能力。

两个内置 Skill 与后台共用编辑规范。结构检查不能替代人工语义审核。独立 toolkit MCP 保留 schema:1 文本/规划流程及独立存储；其导出的 `./capture` API 是工作台使用的富文本内核。新增 `article_image_capture_source` 和 `article_image_source_page` 工具抓取并分页读取独立富文本快照，不修改旧记录。MCP 结果不表示工作台理解或人工审核完成。

## Releases and recovery

独立更新器保留现有发布来源。[发布准备](release/README.zh.md)构建产物，不进行发布。移除组合包保留数据。回退时先停止插件，保留整个 profile 目录，再让旧包使用未修改的 schema:1 文件或备份；旧包不能读取 `state.v2.json`。参见[升级说明](../../../docs/upgrade-guide/v0.2.0-rc.2/article-image-workflow/guide.zh.md)。

## Known Limitations and Deferred Work

完整性限于已配置站点模板及明确核对的范围。登录/付费/验证页、不支持的视觉内容、原图缺失和预算不足阻止分析。解码支持 PNG、JPEG、GIF 和 WebP；不支持的格式显示为失败。真实站点覆盖及模型质量需要执行[验收流程](../../../openspec/changes/article-image-understanding-workbench/acceptance.md)；确定性 fixture 无法证明这两项。未连接生图 SDK 或发布适配器。

## Dev Note

无。
