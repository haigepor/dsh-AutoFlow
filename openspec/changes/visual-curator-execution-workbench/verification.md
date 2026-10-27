# 实施与验证记录

## 完成范围

A→B→C 已按顺序实现。A 复用原 action、用途记录与 RunEngine，增加只读准备、乐观并发保存和两步启动；B 复用 Session 授权与 TaskHistory，增加可信会话工具入口、真实入选身份、筛选分页和范围隔离；C 复用原画像、recipe、模型请求与 assessment，固定当前规则说明和版本化终图匹配策略。新任务默认门槛为可配置的 0.75，历史无版本策略任务保留原行为。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| 插件目录 `node --import tsx/esm --test tests/*.test.ts` | 269 passed，0 failed，0 skipped |
| 插件目录 `node scripts/check.mjs` | Host、Client、测试三组类型检查通过 |
| 插件目录 `node scripts/build.mjs` | 通过；最终根构建也包含该插件 |
| 根目录 `pnpm run build:artifacts` | 最新构建 10 gates passed，358 Client artifacts |
| 随后的 `pnpm run build:check` | 2 gates passed |
| 根目录 `pnpm run test:docs` | 21 gates passed |
| 指定 README/guide 的 `pnpm run verify-translation-pairing -- ...` | 两组配对一致 |
| `openspec validate visual-curator-execution-workbench --strict` | 通过 |

定向回归覆盖准备零写入/零外部请求、用途最新版本与并发拒绝、准备后输入/用途头变化、已受理启动重放、仅真实 selection 计入选、跨筛选游标拒绝、迟到页面及错误抑制、Session 令牌失效后撤下私有视图。录制 AgentLoop 直接用 visual_task_prepare 的 normalizedInput 和 preparationDigest 调用启动工具，不再手工重建参数。

风格回归覆盖改绿为红的实际提示、全违反不入选、备选组、共享偏好、未知证据、同维度权重分摊；恢复一个无 executionRecipe 的旧模型画像任务，确认固定 spec 不变、使用旧行为且不补写 styleMatch。原供应商请求回放、取消、权限、人工发布、独立裁图及导出测试保持通过。

## 浏览器验证

使用 Playwright MCP 与独立 Temp DSH_HOME，通过受支持的 dsh profile 启动 Web，并保留原目录选择测试 overlay。浏览器 fixture 使用真实 Service、媒体处理、RunEngine、Session/AgentLoop 和原授权路由，仅图片来源与模型 HTTP 是受控响应；不读取或调用真实模型凭据。

已实际执行创建素材集、引用 800×400 PNG、生成画像、保存 100×100 用途、只读检查、启动找图与自动裁剪，确认最终入选只有 100×100 成图，而全部候选另外保留通过的源图。带安全区域的第二个用途产出 200×200 成图，真实结束原因为 target-met、1/1。独立裁图沿用同一用途、规则和准备检查，已完成并产出真实 200×200 图片。

通过真实会话中的 visual_run_get 工具卡片“打开任务”，工作台先取得原 Session grant，再展示该 Session 的实际成图与结束原因。返回素材库后恢复普通范围。卡片原始响应仍可展开。

390×844 下 document.scrollWidth 为 390；展开安全区域长表单时弹窗位于 y=24、高 796，内容区域独立滚动，底部操作位于 y=760～796。准备预览显示格式、安全约束、规则、门槛与请求上限。深浅主题均复用原 token。首次焦点落在任务描述，Escape 关闭后焦点回到启动按钮；进入设置再返回时，任务描述和预算仍保留。

本地截图在 `.playwright-mcp/execution-session-desktop.png`、`.playwright-mcp/execution-dark-desktop.png`、`.playwright-mcp/execution-usage-mobile.png`、`.playwright-mcp/execution-ready-mobile.png` 和 `.playwright-mcp/execution-crop-mobile.png`。这些为本地验证产物，不进入插件发布。全量重建时运行中的开发页曾出现 HMR root 注册顺序错误；已重启隔离实例，使用最终构建重新验收，不修改共享 HMR 或布局模块。

## 文件与影响

| 文件范围 | 用途与影响 |
| --- | --- |
| `src/host/service.ts`、`src/domain/curator.ts`、`src/shared/task-preparation.ts`、`src/host/tools.ts` | 用途发现、只读准备、共享解析、摘要检查及 Agent 准备入口；既有启动入口继续兼容 |
| `src/client/task-dialog.tsx`、`workbench.tsx`、`style-profile-dialog.tsx`、`execution-locale.ts`、`workbench-locale.ts`、`transport.ts`、`entry.css` | 原组件内增加两步流程、安全区域表单及响应式滚动，保留现有视觉风格 |
| `src/host/projection.ts`、`src/client/contract.ts`、`store.ts`、`task-history.tsx`、`task-tool-view.tsx`、`index.ts` | 真实 selection 与汇总、原 Session 入口及失效隔离；资源鉴权仍由原服务决定 |
| `src/host/style-execution.ts`、`config.ts`、`search-workflow.ts`、`crop-workflow.ts`、`review.ts`、`src/shared/model.ts`、`style-matching.ts`、`src/media/vision.ts` | 当前规则及新任务策略，保留历史执行行为；新字段向后读兼容但不承诺旧插件恢复新任务 |
| 插件测试与 `tests/fixtures/` | 定向回归、owner-local 预期输出、可复现浏览器会话夹具 |
| 插件 `package.json`、根 `pnpm-lock.yaml` | 增加两个现有工作区开发类型依赖；lock 仅新增 6 行，不新增第三方运行依赖 |
| 插件双语 README、配对元数据及版本升级指南 | 记录用户流程、九个 Agent 工具与新任务行为差异 |
| 当前 OpenSpec change | 固化范围、决策、验收及本记录；未自动归档 |

## 限制与回滚

真实模型的图片质量、规则识别准确度与 0.75 门槛校准尚未通过真实样本验收，本次证明流程、权限、持久状态和受控结果正确。未实现反馈学习、拖拽裁剪或批量交付。

原插件文件备份位于 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-execution-73d86c1f5da84e059f00442d4bba4ef0`。回滚时仅恢复本轮对应文件并移除本轮新增文件，单独撤销 lock 的两项依赖；保留已写入的数据，不在旧插件恢复新策略任务。用户原有其他暂存改动保持原样，本轮未提交或推送。48 个范围内文本文件严格 UTF-8 解码、BOM、替换字符、末尾换行与混合行尾检查通过；git diff --check 通过。
