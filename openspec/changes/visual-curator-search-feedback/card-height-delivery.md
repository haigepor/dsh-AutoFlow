# 卡片剩余高度、任务批次结果与数据集分析交付

卡片高度及按批次展示已实施；数据集主体、多轮学习和最终版本的整理机制仅完成分析，见 [数据集整理分析](dataset-consolidation-analysis.md)。没有修改现有数据集记录、创建生产找图任务或重启用户服务。修改未提交、未推送。

## 页面行为

右上角卡片展开后分配任务清单下方的全部剩余 body 高度，结果区内部滚动，顶部信息与操作保持可见。清单展开和页面尺寸变化会重新分配高度；收起恢复紧凑高度。拖动宽度、键盘调整、Escape 焦点返回、窄侧栏隐藏和按 Session 隔离均保留。原来的 360px / 42dvh 结果限高已移除。

“找图与裁剪”默认读取当前分组的全部匹配结果，并按原始找图或裁剪 Run 分批展示；提供单批次筛选、图片预览、批次及批内图片分页。“任务详情”保留原 Run 的控制和诊断，返回“全部批次”退出单会话范围。

原空白的原因是素材库快照与 Session 任务拥有不同读取范围。新的 `search-batches` 入口仅供已认证的工作台所有者读取同一分组的批次，逐个使用原 Session 授权生成资源路径；没有修改通用 Run 授权，也没有向 Agent 开放跨会话读取。原会话暂不可读时保留批次并提示 unavailable。切换分组、关闭视图及插件释放会取消观察，迟到响应不能覆盖新分组。读取不启动任务、不下载原图、不调用来源或视觉模型。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `node scripts/test-preview-search.mjs` | 64 项通过，0 失败、0 跳过；其中新增批次读与客户端回归覆盖跨集合隔离、原 Session grant、Agent 拒绝、独立分页、迟到响应和刷新保留尾页 |
| `tests/conversation-task-dock.test.ts` | 会话任务发现的既有回归通过 |
| `node scripts/check.mjs` | Host、Client、tests 三组类型检查通过 |
| `node scripts/build.mjs` | 插件入口构建通过 |
| 原生卡片浏览器预期输出 | 全部一致，0 pageerror；1920×900 时卡片高度 832px、底部 888px 与侧栏相同；清单展开后变为 746px、底部不变；1920×500 时结果区 95px、内容 306px，实际滚轮可滚动且标题不移动；390px 保留原隐藏规则且无横向溢出 |
| 原生批次页面预期输出 | 全部批次默认显示、单批次筛选、预览、任务详情及返回全部均通过；390px 无横向溢出，0 pageerror、0 console error |
| `pnpm run build:artifacts` | 12 个构建检查通过，0 失败 |
| `pnpm run build:check` | Host 汇总通过；Client 因范围外 `packages/client/ui-chat/tests/user-content.client.spec.tsx:91` 缺少 `inject` 而失败 |
| `DSH_SNAPSHOT=replay pnpm run test:web` | 前置 build 的同一 Client 汇总错误阻止浏览器 replay 启动；13 个构建检查通过，1 个失败。没有把 replay 记为通过 |
| `pnpm run test:gui` | 11149 项通过、33 项失败、2 项跳过；15 个文件失败。失败涉及现有 ui-chat、ui-tool、ui-deliverables、ui-theme 等范围外用例；滚动条错误指向 `ui-settings-models/SubscriptionPage.module.css`，不是本次 ConversationRoot 样式 |
| README 配对与 OpenSpec strict | 两组 README 配对及当前变更 strict 校验通过 |

全仓检查处于部分通过状态，不能声明整个仓库测试通过。上述流程使用受控外部响应与原生组件 fixture，不代表真实图库风格或付费模型效果验收。

## 修改范围

下列插件路径以 `custom-plugins/workspace/dsh-plugin-visual-curator/` 为起点；逐文件前后哈希与补丁记录在回滚目录的 `changes.json` 和 `task-only.patch`。

| 文件 | 用途与影响 |
| --- | --- |
| `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css` | 为通用纵向侧栏传递确定高度；空白不拦截指针 |
| 插件 `src/client/conversation-task-dock.tsx`、`src/client/entry.css` | 卡片剩余高度分配、滚动区域、现有折叠组件布局及批次页样式 |
| `src/shared/search-batches.ts`、`src/host/search-batches.ts`、`src/host/service.ts` | 新的人类只读批次分页与原 Session 资源授权 |
| `src/client/search-batches-store.ts`、`src/client/search-batch-results.tsx` | 独立观察、筛选、分页、预览和批次显示 |
| `src/client/index.ts`、`src/client/transport.ts`、`src/client/workbench.tsx`、`src/client/search-feedback-locale.ts` | 原生注入、HTTP 路由、入口集成、原任务详情和本地化 |
| `tests/search-batches.test.ts`、`tests/search-batches-client.test.ts`、`scripts/test-preview-search.mjs` | 授权、集合隔离、分页和客户端时序回归 |
| `tests/fixtures/conversation-task-dock-ui.mjs`、`conversation-task-dock-browser.mjs`、`conversation-task-dock.expected.json` | 使用实际 body overlay 与 TodoPanel 检查高度、滚动及交互 |
| `tests/fixtures/search-feedback-ui.mjs`、`preview-search-browser.mjs`、`preview-search-ui.expected.json` | 原生批次页和任务详情的预期输出 |
| 插件及 `packages/client/ui-conversation/` 的 README 中英文件与配对记录 | 同步可见行为和授权说明 |
| 插件构建入口 `index.js`、`client.js` | 由源码重新生成的 Host 与 Client 产物；其余入口如无差异不计入补丁 |
| 本目录的 spec、此交付文件和 `dataset-consolidation-analysis.md` | 当前页面要求、验证记录及待实施的数据集整理方案 |

仓库整体构建还会按既有流程重新生成其他当前源码对应的产物；本次没有手改其他功能源码。

## 回滚与加载

本轮修改前的文件保存在 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-card-height-20261029/before/`，保留当时已有的未提交修改。相邻的 scope、哈希及增量补丁只记录本轮范围。先运行 `git apply --reverse --check --whitespace=nowarn` 检查 `task-only.patch`，再决定逆向应用；后续修改重叠时不要 reset 或整文件覆盖。生成代码中依赖字面量的有意空白保持原样。

新批次接口需要重载应用服务并刷新页面。数据集页面和找图选择器目前仍按原机制工作，后续整理应同时修改最终版本指针、导出、页面与启动校验，不能只更换选择器文案。
