---
description: "在 AutoFlow 中只读导入文章并审核编辑配图提示词。"
kind: "package-bundle"
---

# 文章生图

[English](README.md) | 中文

## Summary

这个独立版本的组合包从公开 Google 表格导入文章链接，提取正文，由会话 Agent 保存写实编辑配图方案，再在工作台审核。Google 表格保持只读。生图、上传、私有表格 OAuth 和定时执行尚未接入。

## Installation and development

CLI 内置此包，新 Web/Desktop profile 默认启用；已有 profile 保留原有选择。可在插件页启用“文章生图”，或使用 `pnpm dsh plugin --profile web add file:<absolute-package-directory>`。Headless 与 SDK 默认不启用。运行 `pnpm --filter dsh-plugin-article-image build:client` 构建，`pnpm --filter dsh-plugin-article-image test` 测试，`pnpm --filter dsh-plugin-article-image check` 检查语法、入口与编码。

## Workflow

从主侧栏打开文章生图，在紧凑标题栏点击“导入文章”。原生弹窗包含公开 Google 表格链接及文章链接、分类、语言和备注表头映射；可选映射可留空。导入结果和错误保留在弹窗中。导入保留来源行及业务字段，继承空白分类，报告无效链接，并按表格、工作表和保留查询参数的 URL 去重。重新导入只更新来源元数据，不替换已保存正文或方案。远端表格变化仅在明确导入时应用。

选择文章并抓取正文。读取先使用已配置的原生网页提供方。启用大小恢复时，仅在响应过大或成功的 HTML 被截断后，通过原生匿名 HTTP 重试一次，保留公开地址与同源跳转检查。拒绝访问、登录或验证页、不支持的内容、网络异常与超时分别报告。必要时手动提供标题和完整正文。文本与网页属于不可信数据；解析 HTML 不执行脚本或加载资源。读取标题不能代表已读取文章。

复制 Agent 指令到会话发送。两个内置 Skill 指导 Agent 分页读取所有已保存段落，保存文章理解及图片提示词。默认一张封面、两张正文图、16:9，中文说明、英文最终提示词；张数与比例可编辑。每张图引用真实段落编号，记录配图理由、主体、动作、环境、构图、光线、色彩、风格、细节和避免事项。在工作台审核通过不会生图。保存修改会使原审核失效，过期正文摘要值或记录版本会被拒绝。

工作台复用共享 Button、Input、Checkbox、Menu、Modal、Tooltip、SegmentedControl 和 AnimatedCollapse。语义颜色与动效 token 跟随当前主题，并支持减少动态效果。桌面任务侧栏可折叠为 56px 工具条，窄屏收为紧凑标题；控件保留挂载，列表位置不丢失。文章元信息、标签页和当前操作集中在紧凑阅读头部。抓取状态显示在文章区域内，不另设全局任务条。搜索筛选当前页，分类与翻页由 Host 读取。切换文章前，未保存的方案或手动正文需要确认。生成的透明 Logo 与随主题变色的 SVG 插画见[素材说明](assets/README.zh.md)。

## Configuration and records

根 Cordis 行验证默认来源、列映射、行数、正文及字节上限、请求超时、抓取并发、分页和轮询配置；接受字段见 `config-schema.js`。工具、工作台和 Skill 可分别开关。Skill 直接注册到运行时目录，不覆盖 Home 文件。

原始 HTML 限制与提取后的正文长度分别管理。大小恢复默认为 `retryLargeHtml: true`、`maxArticleHtmlBytes: 8000000`、`maxArticleHtmlChars: 2000000`，仅影响该次匿名 HTTP 请求；要求全部请求都经过指定提供方时可关闭恢复。`articleUserAgent` 与 `maxRedirects` 同样用于恢复请求。两次网络尝试共享 `requestTimeoutMs` 时限，停止或超时后仍会等待本地清理完成。`maxArticleElements` 默认 50000，`maxArticleChars` 将保存正文限制在 100000 字符。提高限制或使用浏览器都不能证明正文完整。

记录位于 `$DSH_HOME/.plugins/dsh-plugin-article-image/profiles/<profile-path-hash>/state.json`，与安装包分离。原子替换及跨进程写入锁保护提交，路径拒绝用户控制的链接。关闭页面不会取消任务。停止任务或卸载插件会取消并等待抓取结束。排队的编辑和导入会在卸载时取消，已经开始提交的写入会等待完成后才结束停用；进程异常退出留下的记录显示为中断，可明确重试。包升级保留记录和方案。记录不包含凭据或图片字节。不发布 invariant 伴随入口，因为记录与页面共用一个权威存储，不存在独立持有的观察值。

## Model Experience

Agent 可见原生工具、两个内置 Skill 摘要，以及按需通过持久工具结果返回的已保存正文段落。Skill 按需加载。文章与方案仅在返回或提交时消耗请求 token，没有独立后台模型调用或隐藏的正文注入。工具元数据支持通用结果卡片回放。生图明确报告不可用，不进行模拟。

后台抓取通过原生 `job_output` 收集结果后再读取报告，结果标明实际抓取方式及是否进行了大小恢复。状态工具返回按 `toolResultBytes` 计算的单批上限，保证结束结果保留每篇文章的状态。报告提供来源地址、抓取时间和受限长度的来源备注。按 `sourceHash` 分页读取段落，直到 `nextOffset` 为 null；每页同时满足 `articlePageChars` 和完整 JSON 字节预算。重新抓取失败时可保留早先正文，但失败状态和原因会继续返回，在抓取或手动替换成功前不能保存新方案。

## Releases and recovery

组合包声明现有 GitHub 更新器来源，版本与 AutoFlow 独立。[发布准备](release/README.zh.md)在不发布的情况下生成 tarball、校验值与精确版本元数据。更新需要重启。停用或移除包保留本地记录，安装旧包不会撤销数据变化；手动恢复前应保留状态文件。

## Known Limitations and Deferred Work

正文提取使用 [Mozilla Readability](https://github.com/mozilla/readability) 与不执行脚本的 [jsdom](https://github.com/jsdom/jsdom) 文档，不能证明发布方交付了完整内容。已识别的登录、验证页与受限摘要会被拒绝；未识别的页面或客户端渲染内容仍可能需要手动补充。当前没有浏览器执行、CMS 适配器或外部抓取服务。手动补充会明确标识。内容相关性仍需编辑判断，不是自动评分保证。真实生图提交、不确定请求核对、本地图片下载、费用限制、表格回写及远端图片上传需各自的适配器和验收。

## Dev Note

无。
