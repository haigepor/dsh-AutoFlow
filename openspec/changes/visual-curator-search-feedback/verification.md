# 实施与验证

本变更修复找图诊断及交付目录提示，并提供原生对话卡片、真实 Run 数据、工作台分类和 body 内的任务胶囊。原有 `visual-curator-session-search-launch` 保持独立归档及独立提交；本变更不归档，不推送。

## 诊断证据

只读检查截图任务对应 Run 的最新 checkpoint、请求、assessment、warnings 和交付 manifests。保存时为 6 张候选、4 张已导入、0 张最终合格；两张候选在成功 lookup 后没有进入下载，另有初筛通过后终审待复核和终审不通过的记录。旧 `reference-unavailable` 混合了多个阶段，不能据此判定参考图片损坏或视觉淘汰。图库适配器对受限原图的明确标记，以及 lookup、下载和导入的独立诊断，均由确定性用例验证；历史记录不补造授权信息。

零合格时，交付函数不创建目录，也没有交付回执。新启动指令明确禁止提前扫描预计目录，`run-get.delivery` 只在已有回执时提供实际路径。零结果组合用例同时检查 API 的 pending 状态、目录字段缺失和文件系统的 ENOENT。未重启原任务或写入用户运行数据，未调用真实付费模型或图库接口。

## 检查结果

| 检查 | 状态 | 实际证据 |
| --- | --- | --- |
| 初始失败回归 | PASS | 先观察受限原图标记、缺失原图计数、启动目录提示三个用例失败，再修复到通过；另观察反转仓库枚举顺序导致未入选图片分页漂移的用例失败，再固定身份排序到通过。 |
| 共享工作区插件回归 | PASS | 最终 `node --import tsx/esm --test tests/*.test.ts tests/*.test.mjs`：425/425。 |
| 隔离候选插件回归 | PASS | 独立 HEAD 加本变更差异的最终候选：387/387，未携带前序数据集工作区、原生上下文或其他插件修改。 |
| 插件编译面 | PASS | 共享工作区及隔离候选均执行 `node scripts/check.mjs`，覆盖 Host、Client、Tests；交付前重新构建插件。 |
| 原生会话组件 | PASS | `todo-panel.client.spec.tsx` 和 `skeleton.client.spec.tsx`：共享工作区及独立候选均为 51/51；此前相关包完整回归为 53 文件、868 项。 |
| Recorded Session | PASS | 共享工作区与隔离候选分别执行 `visual-curator` 场景的 keyless refresh 和 replay，均为 1 passed；复核新字段与技术失败 outcome，并把内嵌工具返回中的旧 job 字面身份与已生成的同一关系 token 对齐。提交使用独立候选的配置签名；共享工作区保留与前序原生上下文配置相符的记录差异。没有修改通用 normalizer 或 Session 格式。 |
| 浏览器 | PASS | Playwright MCP 执行真实 TodoPanel、ConversationContent、TaskToolView 和 TaskHistory；1920px、390px、明暗主题、宽窗口中的 600px 会话、Enter/Escape、会话隔离、断线保留、恢复、导航、结果筛选和来源诊断全部符合 `search-feedback-ui.expected.json`，无 pageerror 或横向溢出。外部响应使用受控夹具。 |
| 构建 | PASS | `pnpm run build`：14/14，包含 artifacts 和 Host、Client aggregate check；最后的插件内部诊断及标签修正另做插件类型检查和 bundle 构建。 |
| 文档快速检查 | PASS | `pnpm run test:docs`：21/21；两个 README 双语对同步更新配对记录。 |
| 客户端生成目录 | PASS | 隔离候选的 `gen-client-catalog.ts --check` 通过；新增 overlay、Todo 占位移动及本次产生的源码行号变化随生成结果提交。 |
| OpenSpec | PASS | `openspec validate visual-curator-search-feedback --type change --strict --json`。 |

最近一轮共享工作区 `pnpm run doc-sync` 为 38/43。未通过项为事件图、客户端目录、持久化目录、持久化类型历史和 tsconfig paths。共享源码中存在前序 Session、模型和包配置修改；本变更的候选客户端目录独立校验通过，其余生成漂移保留给各自原变更。没有将全仓检查描述为通过，也没有覆盖这些共享文件来消除提示。完整输出见隔离记录目录的 `docs-sync.log`。

## 修改范围与影响

| 文件组 | 用途与影响 |
| --- | --- |
| Visual Curator `media/source.ts`、`media/unsplash.ts`、`host/search-workflow.ts`、`shared/search-feedback.ts` | 明确受限原图、保存候选阶段与技术诊断，技术失败报告 partial-failure；不使用预览冒充原图。 |
| `host/projection.ts`、`service.ts`、`tools.ts`、`search-launch.ts` | 从最新 assessment 和 selection 推导互斥分类，加入处理中图片、交付回执和独立 Session 读取信息；未知终审不合格。 |
| `client/conversation-feedback.ts`、`task-tool-view.tsx`、`index.ts` | 按 Session/Run 共享观察，最后一个观察者退出时取消；终态停止轮询，重连忽略过期响应；原始材料保留展开。 |
| `client/task-history.tsx`、`contract.ts`、`store.ts`、locale 和 `entry.css` | 全任务数量、分类筛选、中文诊断、逐图状态及明确空状态，保留现有主题和控制行为。 |
| ui-conversation 的 TodoPanel、ConversationContent、slot 声明、注册及 CSS | 通用 Session overlay 位于 body 内滚动层之外；胶囊只占正文右侧空白，窄容器隐藏，详情保留全文及键盘交互。 |
| `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` | 由候选源码生成本轮插槽目录，不携带共享源码中的其他目录变化。 |
| 各自 tests、browser fixtures、README 对及 `snapshots/session/visual-curator/` | 针对性回归、可执行浏览器期望、API 文案及现行模型输出回放。 |

## 隔离与回滚

实施前文本副本、初始状态、候选清单、合并证据、独立索引和检查日志位于 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-search-feedback-20261029/`。提交使用独立候选工作树和索引运行原有提交钩子，真实共享工作树不被候选覆盖。回滚仅审查并还原本变更对应差异，再重建；不重置共享工作区，不删除用户 Run、数据包或已交付文件。

原图截图保留在 `.playwright-mcp/search-feedback-desktop.png`、`search-feedback-narrow.png`、`search-feedback-workbench.png`，查看时遵循 image guard。原有 Session 和数据包格式均保持，旧 checkpoint 的新增字段缺失时按兼容默认值读取。
