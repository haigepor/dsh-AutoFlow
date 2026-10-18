# 抓取失败与进度诊断

本次范围：修复第一期正文等待与进度展示，增加持久诊断，核对两篇真实失败来源。保留原有未提交改动，不接入真实生图，不替用户完成语义验收。

## 两篇来源的实测结果

| 来源 | 原失败 | 实际原因 | 修复后结果 |
| --- | --- | --- | --- |
| [巴西央行公告](https://www.bcb.gov.br/detalhenoticia/21275/nota) | `article-short`，原任务约 37 秒 | HTTP 200 只说明网页壳加载成功；5 秒正文等待不足以等待 Angular 正文，随后请求收尾又拖延失败返回 | 同一 Chromium 内核配合正文等待和正文选择规则，约 23 秒取得 112 字符、1 个正文块、0 张正文图片；标题正确，原文链接保留；后台资源活动触发人工正文核对 |
| [Folha 旅游文章](https://www1.folha.uol.com.br/turismo/2026/10/roteiro-de-36-horas-no-lago-de-como-na-italia-destaca-vilarejos-arte-e-gastronomia.shtml) | `article-restricted`，原任务约 87 秒 | 真实页面显示免费阅读额度已用尽，正文容器被隐藏，存在活动的订阅限制层 | 保留受限结果，展示明确的阅读额度/订阅限制说明；新的请求收尾复现约 24 秒取得页面并结束；不把隐藏正文作为完整文章 |

耗时来自各一次真实网络运行，受网络及站点状态影响，不是性能基准。央行页面本身是指向统计数据的简短公告；没有自动打开链接并把另一个页面拼接成原文。

## 工具能力判断

Playwright/Chromium 能运行这两篇页面的脚本，问题不能归结为浏览器内核不可用。当前工具包的主要缺口在正文就绪、提取范围、失败分类和网络兼容性。

正文提取默认选择首个 `article` 或 `main`，有可能包含工具栏、推广图及多个内容区域。已清理浏览器计算样式隐藏的内容，并为当前 Web profile 的央行公告配置 `.detalhe-noticia .corpo` 正文范围、`promise` 末尾检查。该规则属于配置中的特定发布方模板；站点改版需要复验，不能推广为全部网站的完整性保证。

旧访问限制检查在全页搜索带 paywall 名称的元素及宽泛订阅词，存在误判推广文字的可能。当前检查排除隐藏模板，要求明确的阅读限制提示；本篇 Folha 的限制是真实存在的，不是该宽泛规则造成的假阳性。

浏览器请求仍经过 Node 的地址固定 HTTP 传输，只接受 GET/HEAD，不复用登录 Cookie，不传回 Set-Cookie，拒绝跨源跳转。这保障现有网络范围，但与普通浏览器并不完全等价。依赖登录、POST 数据接口、跨域跳转或特殊请求头的站点仍可能失败；本次没有以放开这些限制来宣称通用兼容。

正文图片仍限 PNG/JPEG/GIF/WebP，并验证实际解码。未知正文范围、未完成加载、缺图和不支持的可视内容分别保留诊断。后台统计请求未结束本身不等于正文缺失；没有其他缺失证据时允许人工对照来源确认，已知缺失仍不能确认跳过。

## 本次变更

- 渲染：导航和正文等待共用 `renderTimeoutMs`；资源稳定等待使用 `renderWaitMs`；捕获结束先取消所属在途请求再收尾。
- 错误：空正文等待超时单独报 `article-content-not-ready`；短公告和真实阅读限制有不同提示。
- 日志：保存尝试编号、时间、阶段、HTTP 状态、资源来源域、文字/内容块/图片计数及安全错误码；默认最多 80 条，省略数量可见。日志不包含正文、Cookie、凭证、URL 路径或查询参数。旧任务无法补录历史日志，新尝试会重新记录。
- 页面：正文、理解与提示词、审核结果和运行诊断四个独立工作区；等待时使用 Git 原版文章插画，移除新增任务卡、侧边竖线、流程步骤和灰色文章骨架。已有正文在分析期间保持可读；停止和恢复使用现有操作栏。阶段及本地计时位于运行诊断页，终止后冻结耗时；日志与 Debug 切换、复制和持久记录保留。
- 轮询：状态与列表并行读取；本地计时不再等待轮询返回。

核心文件：[renderer](../../../custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-renderer.js)、[提取器](../../../custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture.js)、[任务服务](../../../custom-plugins/workspace/dsh-plugin-article-image/src/host/workflow-service.js)、[日志记录](../../../custom-plugins/workspace/dsh-plugin-article-image/src/host/run-diagnostics.js)、[进度与诊断页面](../../../custom-plugins/workspace/dsh-plugin-article-image/src/client/workflow-panels.js)、[样式](../../../custom-plugins/workspace/dsh-plugin-article-image/assets/workbench.css)。对应 schema、配置、双语文案、README 和测试同步更新。

## 验证与回退

插件完整回归 15 文件、136 项通过；后续增加后台资源人工核对场景后，相关任务/页面 29 项通过。抓取相关首轮 37 项通过；最终 renderer/提取器 32 项通过，包括延迟正文、请求取消、隐藏推广、真实访问限制和超时分类。

真实 Web 全流程通过：本地计时、运行日志/Debug 点击与方向键切换、后台处理、草稿保留、停止/恢复、人工审核、明暗模式与 390px 窄屏。窄屏检查等待异步布局完成后断言实际溢出量；没有放宽宽度阈值。recorded Session 只读 replay 通过。客户端构建、语法、UTF-8、语言键一致性、双语记录和差异空白检查通过。

本次修改前的源文件备份：`C:/Users/haige/AppData/Local/Temp/article-image-progress-before-1792177848398/`；同目录 `profile-cordis.patch.yml` 是增加央行规则前的 profile。按文件对照回退本次变化并重建客户端，避免覆盖此后编辑。文章数据未重置。真实模型的语义验收仍由用户手动完成。

后续优先按实际表格发布方积累正文模板及成功/失败样本；如需登录会话或 POST 接口支持，应单独设计权限与网络校验，不把更换抓取工具当成全文可得的保证。

Git 原版已核对插件的既有客户端实现：等待态使用 `ai-empty-block ai-retrieving` 和已有 Illustration，不含 Progress/Processing 面板。仅恢复这些客户端区域，保留富文本、分析、审核、日志及此前未提交改动；未执行 Git 整体回退。修改文件为 src/client/workbench.js、src/client/workflow-panels.js、assets/workbench.css、client.js、组件/Web 测试、README.md、README.zh.md、README.i18n.yaml 和本文。回退源为 `C:/Users/haige/AppData/Local/Temp/article-image-before-git-style-restore-1792181118259/`，按文件对照并重建客户端。

当前手动验证服务：`http://127.0.0.1:3080/`；启动日志 `C:/Users/haige/AppData/Local/Temp/article-image-restored-web-20261017-041105/`。注册资源版本 `cf5b841bb958` 返回 HTTP 200，确认移除任务卡和流程工作区并保留原版插画及诊断。组件 16 项、真实 Web 全流程、构建与静态检查、UTF-8、双语配对及差异空白检查通过。Web 测试覆盖恢复后的等待样式、停止/恢复、日志/Debug、草稿及人工审核、明暗模式和 390px 窄屏。截图位于 `C:/Users/haige/AppData/Local/Temp/article-image-ui-evidence-B0cCSN/`；当前用户页面截图为 `C:/Users/haige/AppData/Local/Temp/article-image-restored-git-style.png`。真实模型语义验收仍由用户完成。
