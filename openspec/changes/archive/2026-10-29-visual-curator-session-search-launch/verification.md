# 实施与验收记录

本变更实现简易找图弹窗、原图交付、原生工作区会话启动与恢复。新会话使用原生默认模型；视觉检查继续使用插件自己的配置。开始后提交真实数据集附件与首条指令，工作台关闭不会撤销已受理的启动。本变更于 2026-10-29 归档并同步正式规范，提交身份以 Git 历史为准，未推送。

## 验收结果

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 插件回归 | PASS | `pnpm test`：416/416，通过原图、用途裁剪、导出及已有流程。 |
| 插件类型检查 | PASS | `node scripts/check.mjs`：Host、Client、Tests 三个编译面。 |
| 代码检查 | PASS | 针对插件源码和新增测试执行 `pnpm exec oxlint`，无报告。 |
| 原生组合与恢复 | PASS | `search-launch-composition.test.ts` 经真实 Loader、SessionController、Workspace、FileUploads、AgentLoop 和 Jobs，故意丢失一次已受理消息回执后恢复，验证一条用户任务、一个找图 Run、原生文件附件、工作区归属及撤销注册。只有外部模型和媒体使用夹具。 |
| 权限与交付 | PASS | 原图字节与摘要一致；不调用裁剪；未知终审不合格；其他 Session 读取拒绝；输出目录重定向拒绝；已有异内容文件不覆盖；停止仅取消本会话及关联 Run。 |
| 冻结与生命周期 | PASS | 旧画像在引用变化后仍通过受理记录校验导出原包；新启动拒绝过期画像。断线、重复点击、重启后回执失效、失败后立即重试和同会话内切换素材集均有回归。 |
| 浏览器界面 | PASS | 原生生产组件，独立浏览器上下文；1280px、390px、明暗主题、减少动效、键盘菜单、Escape、尺寸预设、关闭后重开、准确会话导航、同操作重试及停止。无横向溢出、无页面异常，结果与 `search-launch-ui.expected.json` 一致。 |
| 构建产物 | PASS | 最新 `pnpm run build:artifacts`：12/12。 |
| 全仓构建检查 | PASS | 2026-10-29 重新运行 `pnpm run build:check`：Host、Client aggregate 均通过，2 passed、0 failed；此前 `useChatProcessStatus` 的 TS2353 已不再出现。 |
| ui-chat 回归 | PASS | `pnpm exec vitest run packages/client/ui-chat`：52 个文件、857 项测试全部通过，包含功能状态显示和真实详情展开。 |
| 文档 | PASS | `pnpm run test:docs`：21/21；中英文 README pairing 已记录。 |
| 原有会话回放 | PASS | 修正夹具的 reviewer revision 来源，使用仓库 keyless refresh 同步本场景当前录制与工具声明，再运行 `pnpm run test:snapshot -t visual-curator`：1 passed。Session 格式仍为 4。 |
| OpenSpec 与文件完整性 | PASS | 严格 OpenSpec 校验、范围审查、UTF-8 解码、替换字符/BOM 检查及 `git diff --check`。 |

本变更已执行的验收检查全部通过，包括全仓 Host、Client aggregate 检查。没有发起真实付费模型或真实图库检索。

## 主要文件与影响

| 文件 | 用途与影响 |
| --- | --- |
| `src/shared/search-launch.ts` | 新增输出选择、启动输入与进度消息；旧调用仍要求用途。 |
| `src/host/search-launch.ts`、`native-search-session.ts` | 持久化启动阶段、冻结参数、匹配数据包、创建原生会话、附件受理、消息去重、恢复与关联停止。 |
| `src/host/search-workflow.ts`、`review.ts`、`search-results.ts` | 原图来源及最终复核、去重、原字节下载和工作区原子交付；现有裁剪流程继续使用用途。 |
| `src/host/service.ts`、`plugin.ts`、`tools.ts`、`projection.ts` | 接入新操作、可选原生能力、工具参数与授权资源；不修改 Agent loop。 |
| `src/domain/model-profile.ts`、`curator.ts` | 校验已受理任务与完整冻结画像一致，恢复导出时不切换到新草稿。 |
| `src/client/search-launch-store.ts`、`search-launch-dialog.tsx` | 与弹窗生命周期分离的观察、真实工作区及分页用途选择、未知回执恢复、简易表单。 |
| `src/client/index.ts`、`workbench.tsx`、`transport.ts`、`contract.ts` | 找图入口使用新流程，裁图保留原入口；注入精确会话导航。 |
| `src/client/background-task-card.tsx`、`workbench-locale.ts`、`entry.css` | 复用加载卡片、进度、错误反馈与主题样式；显示真实合格数和交付目录。 |
| `tests/search-launch*.test.ts`、`tests/search-workflow.test.ts`、`tests/plugin-tools.test.ts`、`tests/helpers/service-fixture.ts` | 原图、恢复、权限、组合、预设分页与作用域回归。 |
| `tests/fixtures/*search-launch*`、`tests/fixtures/snapshot-plugin.ts` | 可重复的原生界面场景、期望输出、录制夹具及准确失败诊断。 |
| `snapshots/session/visual-curator/session.v4.jsonl`、`tool-schemas.expected.json` | 本场景当前录制及现行九工具声明。 |
| `package.json`、`pnpm-lock.yaml` | 原生公开接口类型依赖与真实组合测试所需依赖。 |
| `README.md`、`README.zh.md`、`README.i18n.yaml` | 新流程、恢复、交付与双语说明。 |

上表源码相对 `custom-plugins/workspace/dsh-plugin-visual-curator/`。构建同步生成插件的 `index.js`、`client.js`、`tools.js`；其他工作区修改均保留。

## 复现与回滚

界面夹具通过 `node tests/fixtures/build-search-launch.mjs` 生成真实 Host 投影，在 `.playwright-mcp/search-launch-native-fixture/` 提供静态页面后，通过 Playwright 运行 `tests/fixtures/search-launch-browser.mjs`。浏览器使用独立上下文以隔离其他任务的路由和缓存；外部响应受控，原生服务执行由组合测试验证。截图保存在 `.playwright-mcp/search-launch-desktop.png`、`search-launch-narrow.png` 和 `search-launch-light.png`。

本轮前置副本、原回放场景、改动清单和完整检查日志位于 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-session-launch-cc124d3745d74fcb811dc337c6c7c6d9/`。回滚时先停止新启动任务，仅审查并还原本轮涉及的改动块，再重建；不要重置整个共享工作区或覆盖其他任务的新修改。保留已创建会话、数据包和交付文件；旧插件不承担继续执行新增原图任务的义务。

原有数据包格式仍为 2，原生 Session 格式仍为 4；新增启动 aggregate 自有版本为 1。未携带新输出选择的历史任务继续要求原有用途，不推断为原图。原生服务缺失不影响旧的 headless 工具，但简易工作区启动会明确拒绝。

复核时，`ui-chat` 源码及已生成的 `ChatViewInjected` 声明均已包含 `chatProcessStatus`，由 `InjectFace` 派生的 `useChatProcessStatus` 编译通过，无需额外修改接口或测试类型。原失败日志保留在前置副本目录；最新全仓检查及 ui-chat 回归已解除该阻塞。本变更现已归档为 `2026-10-29-visual-curator-session-search-launch`。

复核轮次仅更新本文件的验收结果及 `tasks.md` 的收尾说明，不改变应用行为。更新前副本、范围记录和 ui-chat 测试日志位于 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-build-recheck-655fade2e29a4c99a68dafd8d834ba44/`；回滚该轮记录时仅恢复该目录中的对应文档副本。

## 隔离提交复核

2026-10-29 的独立候选仅包含本变更及其最小依赖，排除共享工作区的前序数据集工作区、原生上下文及其他插件修改。候选重新执行 `node scripts/check.mjs`，Host、Client、Tests 均通过；`pnpm test` 为 378/378。上文 416 项及全仓构建属于共享工作区证据，不能替代此独立候选结果。独立候选、索引备份、文件清单和提取脚本保留在 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-archive-commit-5ebded6b01494278966eca3ec75dbf6d/`。
