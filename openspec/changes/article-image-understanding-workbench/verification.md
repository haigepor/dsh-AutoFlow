# 第一期实施与验收记录

日期：2026-10-17。本期代码与自动验证完成，任务 1.1–8.3 共 27 项 DONE；任务 8.4 / AC-25 为 BLOCKED，按用户决定由用户手动验收。尚未获得真实公开站点与真实模型的人工签收，因此不声明业务全部验收。操作与六篇记录模板见 [manual-acceptance.md](manual-acceptance.md)。

已实现富文本与原图获取、自动理解、按内容重新规划配图提示词和人工审核。真实生图、远端素材发布、文章发布、表格回写均未接入。

## 1. 修改与数据保护

| 文件组 | 用途及影响 | 回退 |
|---|---|---|
| [toolkit capture](../../../custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture.js)、capture contracts/media/renderer/service、MCP tools/config、exports | 工作台与独立 MCP 共用 Chromium 内核，保存富文本与原图，检查完整性并限制网络访问；保留旧 MCP 文本接口 | 旧 MCP state.json 不变；新富文本旁存独立保留 |
| [Host workflow](../../../custom-plugins/workspace/dsh-plugin-article-image/src/host/workflow-service.js)、[analysis runner](../../../custom-plugins/workspace/dsh-plugin-article-image/src/host/analysis-runner.js)、store/artifact/rules/shared schema/tools | 自动任务、冻结输入、原子持久提交、停止恢复、精确版本批准与 schema:2 迁移 | 停止插件并保留整个 profile；旧包使用未修改的 state.json 或 legacy 摘要备份 |
| [Client workbench](../../../custom-plugins/workspace/dsh-plugin-article-image/src/client/workbench.js)、workflow panels/view/store、locale/CSS、client.js | 正文原图、真实进度、理解证据、提示词编辑同步和审核 | 与 Host 同步回退组合包；保留任务和草稿数据 |
| package/workspace/lock、桌面 package-target 与测试 | toolkit 成为明确生产依赖并进入桌面分发 | 与对应组合包一同回退依赖及打包清单 |
| 包内 Skill references、[rules](../../../custom-plugins/workspace/dsh-plugin-article-image/rules)、双语 README、[upgrade guide](../../../docs/upgrade-guide/v0.2.0-rc.2/article-image-workflow/guide.zh.md) | 共享文章理解/配图规范、文件规则优先级、配置与迁移说明 | 保留任务已冻结输入和规则；不改变全局 Skills 或配置 |
| 所属 tests、真实 Web 用例、[recorded Session](../../../snapshots/session/article-image-understanding/snapshot.yml)、本变更验收文件 | 保存提取、生命周期、页面、模型日志及产物安装的可重复证据 | 未向用户运行中的 profile 安装 |

实施前 29 份已有修改/方案文件备份在 `C:\Users\haige\AppData\Local\Temp\article-image-baseline-faa88705fbcb449bacb9950ff0112cc3`，其中 baseline.json 保存路径及 SHA-256。最终核对 18 份字节不变、11 份必要增量修改、0 份缺失；19 份原有用户文件中 11 份不变、8 份与本期接入重叠。原抓取回退、清理、登录、表格和原测试改动均保留。没有提交、推送、发布或更新用户运行中的插件。

## 2. 自动验证结果与复现

环境为 Windows、Node.js v25.2.1、pnpm 11.7.0；插件与 toolkit 清单版本均为 0.1.0，本次验证针对当前未提交工作树。规则采用包内默认规范及测试显式覆盖，输入/规则/模型信息由持久 AnalysisInput 与 Session fixture 固定。模型使用测试提供方与 recorded responses，未调用真实付费分析或生图模型。浏览器、HTTP、DSH 会话/附件/日志及 React 页面使用真实实现。测试网络注入仅放行各自拥有的精确随机端口，生产配置不提供此开关。

| 检查 | 实际结果 |
|---|---|
| 插件所属 Vitest | PASS：15 个文件、134 项；随后增强 Host loss 恢复断言的 workflow-v2 文件单独复验 15/15 |
| toolkit 所属 Vitest | PASS：9 个文件、101 项，含真实 Chromium 8 项及独立 MCP 富文本 5 项 |
| 桌面打包清单 | PASS：25 项 |
| 真实 Web 工作台 | PASS：1 个完整流程，覆盖原图输入、关闭重开、引用定位、编辑/同步/审核、停止恢复、停用清理、亮暗主题、390px 窄屏和键盘；生成/发布/表格写入计数为 0 |
| recorded Session | PASS：最终 refresh 和只读 replay 各 1 项；corpus 3/3；包含成功、无结构提交失败、取消及精确版本的完整方案分页读取 |
| Client 构建与 package check | PASS：入口、功能声明、locale 键、JS 语法、UTF-8 和尾换行 |
| 仓库外生产安装 | PASS：实际打包安装 15 个本地产物，无 checkout 链接；规则/模板/Client/共享内核/真实 Cordis Host 加载、浏览器已装与缺失 readiness、原生工具精确版本参数及无批准/生成工具 |
| Host TypeScript | PASS：Host build 及最终 noEmit 检查；最终 Web 测试文件 lint PASS |
| 文档检查 | doc-sync 为 42 项通过、1 项失败；修复本次 Web 测试回调类型后，原失败的 doc-typecheck 单独重跑 PASS（83 个文档块）。其余已通过项未重复运行 |
| 最终静态收尾 | PASS：OpenSpec strict、3 组双语配对、git diff --check；115 个文本文件 UTF-8/无 BOM/尾换行、12 个 JSON 及全部 JSONL 解析、25 份人工编写 Markdown 链接与段落、116 个路径的修改范围和原有文件保留核对 |
| 全仓 lint | FAIL：未修改的 packages/boot/config-editor/src/index.ts:107:48 报 typescript(no-unsafe-assignment)，单文件重跑仍失败；本次 Web 文件问题已修复并单独通过，不声明全仓 lint 通过 |

下列命令在仓库根目录执行，除注明工作目录外。Vitest 直接使用已安装入口，以免本机 pnpm 自动依赖同步干扰并发验收。

```powershell
# 插件目录：custom-plugins/workspace/dsh-plugin-article-image
node ../../../node_modules/vitest/vitest.mjs run --config vitest.config.mjs
node ../../../node_modules/vitest/vitest.mjs run --config vitest.config.mjs tests/workflow-v2.test.js
node scripts/build-client.mjs
node scripts/check.mjs
node scripts/smoke-production.mjs 'C:\Users\haige\AppData\Roaming\npm\node_modules\pnpm\bin\pnpm.cjs'
# toolkit 目录：custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit
node ../../../../node_modules/vitest/vitest.mjs run
# 仓库根目录
node node_modules/vitest/vitest.mjs run apps/desktop/tests/package-target-stages.spec.ts
node node_modules/vitest/vitest.mjs run --config vitest.web.config.ts apps/web/tests/article-image.e2e.ts
node node_modules/vitest/vitest.mjs run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t 'replays article-image-understanding'
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -b tsconfig.host.json --pretty false
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.host.json
pnpm run doc-sync
pnpm run doc-typecheck
node --import tsx/esm scripts/run-oxlint.ts .
```

最终页面证据位于 `C:\Users\haige\AppData\Local\Temp\article-image-ui-evidence-w7mxjc` 的 light-article.png、dark-article.png、light-narrow.png、dark-narrow.png，均已查看；浏览器断开及 fixture server 不再监听已断言。证据属于临时目录，长期保留应复制到用户选择的验收归档位置。最后一次 Web 通过后仅修正该测试文件的类型、lint 和格式，行为断言未变。

## 3. 逐项验收

同号要求、正反例与 fixture 定义见 [acceptance.md](acceptance.md)。以下 PASS 仅覆盖列明自动证据范围；真实公开站点及真实模型的语义判断统一留在 AC-25。

| 项目 | 状态 | 输入、实际观察与证据位置 |
|---|---|---|
| AC-01 | PASS | F01 静态 Chromium fixture 保留标题、内联标记、嵌套列表、表格、引用和 figure 顺序并移除附属内容；toolkit capture-browser 与 Host 集成共用 capture 导出 |
| AC-02 | PASS | F02/F04 动态尾段及同文分页获取成功；未知范围、失败分页、已知缺失分开报告；workflow-v2 拒绝用人工核对覆盖已知缺失 |
| AC-03 | PASS | F03 的 picture/srcset/data-src/noscript/懒加载与重复位置有实际图像字节；capture-browser/media 与 Web reader 核对图注、署名、失败位置；缺图阻止分析 |
| AC-04 | PASS | capture contracts 测试确认图片 bytes、图注及顺序影响 sourceHash；相同 bytes 的签名 URL/时间不影响；重复资产保留全部位置 |
| AC-05 | PASS | capture/artifact/storage-failures/MCP 测试拒绝损坏、伪装和超限资产、非法 ID/路径、半写内容；资产 bytes 与索引分离，Host 读取经认证 |
| AC-06 | PASS | 浏览器安全预览不执行源 HTML，链接协议受限；analysis-runtime 与 recorded Session 的专用 Agent 仅有任务绑定提交工具，来源或备注不能授予 shell/批准权限 |
| AC-07 | PASS | 限制页和禁止目标/redirect/资源请求失败；DNS 解析与实际连接固定，私有/本机地址拒绝；production smoke 覆盖缺 Chromium readiness，未降级冒充完整 |
| AC-08 | PASS | F06 rules 测试比较有效文件内容与 rulesHash，缺文件/坏策略在模型前拒绝；运行时模板与两个内置 Skill 引用同一领域规范，Session 保存实际输入 |
| AC-09 | PASS | analysis-runtime/rules/workflow 冻结正文、原图附件清单、业务字段、规则、模型及预算；修改规则后恢复沿用旧输入，新任务采用新输入 |
| AC-10 | PASS | workflow-v2、真实 Web 与成功 Session 从提取自动进入理解/规划/检查并持久保存 review；导入或复用未变结果不调用模型，句柄/idle 不算提交 |
| AC-11 | PASS | F07 分块/综合覆盖全部 blockId/assetId，真实附件服务和日志记录图像输入；无视觉能力、漏块/图与超预算被拒，不能发布完整方案 |
| AC-12 | PASS | analysis-contracts/runtime 检查主旨、章节、事实证据、限制、疑点及文图关系；拒绝无效引用/哈希/覆盖/重复场景，数量缺口显式记录；真实提示词语义质量待 AC-25 |
| AC-13 | PASS | F08 并发测试仅一个有效 attempt，持久提交后才推进；页面显示实际阶段/计数/耗时，无模型百分比；无结构提交 Session 失败，重开页面延续原任务 |
| AC-14 | PASS | 停止、停用及卸载等待 drain；迟到响应、重抓与手动修改后的旧 attempt 不可写入；恢复队列保留各自 controller；Web 断言浏览器/server 清理 |
| AC-15 | PASS | Client/Host 与 Web 改场景后禁止批准，显式同步提示词后可保存；理解简报变更需复核；旧 revision 拒绝且草稿保留，面板离开/返回及远端冲突可恢复 |
| AC-16 | PASS | Web 核对正文/原图/理解/配图引用，停止恢复与错误入口；四张实际截图无确认操作遮挡；键盘 Enter、状态播报、390px 与减少动态效果有覆盖 |
| AC-17 | PASS | artifact-store/storage-failures 注入资产、快照与索引发布失败，读取只见旧完整版本或新完整版本；损坏/断引用拒绝，不发布半写记录 |
| AC-18 | PASS | F09 migration 测试保留旧 ID/正文/方案/历史审核，旧文件字节不变并另存摘要备份；失败后可重试；legacy 必须重抓才可新批准，upgrade guide 说明旧包回退 |
| AC-19 | PASS | workflow-v2/native/Web 仅允许工作台批准精确 revision/source/input/plan；采用的新源/业务字段/规则或编辑使批准失效；单独行号变化不失效；Agent 无批准工具 |
| AC-20 | PASS | scripts/smoke-production.mjs 在 checkout 外安装 15 个真实 tarball 后导入规则/模板/Client/内核并加载 Cordis 插件；实际浏览器与注入缺失分支均通过；桌面 25 项检查包含 toolkit |
| AC-21 | PASS | Web 关闭重开任务继续；workflow-v2 用实际已退出子进程 PID 验证 Host loss 显示 interrupted、无自动任务/模型；显式恢复沿用冻结输入及已提交阶段且不重抓 |
| AC-22 | PASS | 本地 owner 测试覆盖投影/错误；article-image-understanding 的成功、无提交失败及取消父子 JSONL 经最终 refresh/只读 replay；模型输入、附件、提交 receipt 与完整方案分页均持久可重构 |
| AC-23 | PASS | Host/native/真实 Web/生产安装检查无生成/批准 Agent 工具，正常、批准、批量、重试、恢复路径生成与发布/远端素材发布/表格写入为 0；分析调用单独记录 |
| AC-24 | PASS | Host/Client/MCP/native、双语 README、locale、Skill 和 upgrade guide 已同步；构建/package/typecheck/相关文档检查通过。全仓 lint 的无关既有失败仍列在第 2 节 |
| AC-25 | BLOCKED | 用户明确选择自行手动验收；真实公开文章、真实分析/视觉模型及六篇人工签收尚未执行，按 manual-acceptance.md 填写后再关闭任务 8.4 |

## 4. 检查范围与限制

真实 profile 联调已覆盖配置重解析、Cordis 可选服务访问和分析 cwd；持久输入校验拒绝错源、旧 attempt、旧输入及未同步提示词。少数冷启动曾在并行构建时超时，随后在无主机争用条件下使用原命令和原时限通过；预算专测使用隔离事务内存夹具，真实文件持久化另有失败注入覆盖。没有降低验证条件或把首次失败记录当作通过。

本机未暴露 Playwright MCP，页面运行证据来自仓库现有真实 Chromium/Vitest Web scaffold。生产站点需要声明模板适配或人工核对范围；AVIF/SVG 等未支持图片会明确失败。自动验证不保证任意公开站点提取或真实模型语义质量。AC-25 完成前保持变更未归档；全仓 lint 的 config-editor 问题未在本期修改范围内处理。
