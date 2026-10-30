# 找图弹窗与启动兼容性修复

## DONE：修改与影响

- `src/client/search-launch-dialog.tsx`、`src/client/entry.css`：复用原生 Modal、Select、Button、StateDot、DisclosureRow 和现有主题 token，将表单分为数据与位置、找图要求；底部操作固定、正文内部滚动，生成日期只显示一次。删除弹窗内重复失败卡片，统一展示状态和可展开的安全错误详情，保留原启动的继续、停止和会话入口。
- `src/host/service.ts`：只读启动选项增加 `datasetSelection: required` 能力标记。
- `src/client/search-launch-store.ts`：发送含所选数据集的启动请求前只读确认能力；不向旧 Host 发送不兼容启动，不删除数据集参数绕过校验。只读准备失败不冒充已创建的任务；原先回执未知的任务保留原操作身份。保留 Host 返回的安全错误说明、步骤与建议。
- `src/shared/search-launch.ts`：错误投影新增可选步骤字段；旧错误记录仍可读取，不更改已保存任务输入、数据集或存储版本。
- `src/client/search-feedback-locale.ts`、插件 README 中英文对和配对记录：同步界面文案与启动、恢复说明。
- 本目录 `tasks.md`：记录本次实现及人工验证交接。插件的 `index.js`、`client.js`、`tools.js`、`skill.js`、`page.js` 由原构建脚本生成；没有改动其他插件、全局配置、模型或权限。

上述 `src/` 路径均相对于 `custom-plugins/workspace/dsh-plugin-visual-curator/`。

## DONE：只读排查证据

- Web 服务进程 `14236` 从本地时间 2026-10-29 17:19:13 持续运行；Visual Curator 写锁同样标记该 PID。
- 应用解析到本仓库的 Visual Curator `index.js`。本次修复前磁盘上的 Host 和 Client 产物已在 20:54:25 更新，晚于常驻服务启动时间。
- 引入必选数据集前保存的 `searchLaunchInputSchema` 使用严格对象校验，尚不接收 `datasetId`；新表单明确发送该字段。Host 将 Zod 输入拒绝转换为 `invalid-input`，旧前端只保存错误代码，没有保留详细步骤和说明。
- 只读检查当前 profile 的增量启动记录，仅有一条已停止的历史启动，没有这次新启动的持久化回执。

这些证据与页面已更新、旧 Host 尚未重载而拒绝新增字段的原因一致。未重放截图中的启动请求，也未取得该次已丢弃的内部 Zod 原因；新的能力检查提前识别这种版本不一致，后续错误将保留服务端允许外显的详情。

## DONE：交付边界

按用户要求，不运行自动测试、类型检查或浏览器验证，不自动重启服务，不发起或重试找图，不调用付费模型。只更新插件构建产物、文档配对记录，并检查本次文件编码及增量范围。实际界面、创建会话和找图结果由用户重载后手动确认。

产物生成命令 `node scripts/build.mjs` 正常退出；文档配对使用 `pnpm run verify-translation-pairing --write custom-plugins/workspace/dsh-plugin-visual-curator/README.md` 重新记录，未运行配对校验。修改文件按 UTF-8 读取，无替换字符、BOM 变化或混合换行。

## NEXT：人工操作

1. 手动重启正在运行的 Web 应用服务，再刷新页面；仅刷新浏览器不会替换 Node 已加载的 Host 模块。
2. 重新打开找图弹窗，选择当前画像对应的数据集、工作区和找图要求，再手动开始。
3. 若仍失败，展开弹窗中的错误详情，保留失败步骤、安全错误说明与建议操作；回执未知时继续原启动，避免另建重复任务。

## 回滚

本回合修改前的逐文件备份和范围记录位于 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-launch-repair-20261029/`。`before/` 保留本回合开始时的原文件，`deltas/` 仅记录本回合差异；不要用 Git 整文件还原覆盖其他会话已有修改。回滚本次新增的能力检查时，应同时恢复客户端与 Host 文件并重新构建插件。应用数据、历史会话和数据集未修改。
