# 找图启动摘要布局

工作台找图启动状态并入顶部素材集选择区，以同排紧凑入口显示状态和数量，移除原先独占的内容行。点击原生 Menu 展开完整摘要、真实数量、目录及会话／停止操作；启动弹窗继续直接显示完整摘要。已停止使用中性状态，准备、待执行、结果不足、待确认及失败分别表达，尚无 Run 时只显示目标数量。

修改范围为 Visual Curator 的 workbench.tsx、search-launch-dialog.tsx、entry.css 及相关说明。复用现有 Menu、Icon、Tag、StateDot、Button 和语义 token；启动、重试、停止与会话导航沿用现有 Store。图库导入和数据集后台卡片不受此摘要样式影响。

遵照用户要求未运行自动测试、类型检查或浏览器验证。已执行插件 `node scripts/build.mjs` 并更新加载产物；README 配对记录通过 `--write` 重新生成，未执行配对校验。页面效果待用户刷新后手动确认；未提交或推送。

修改文件：

- `src/client/workbench.tsx`：将启动状态移入顶部素材集选择区。
- `src/client/search-launch-dialog.tsx`：紧凑入口、原生展开菜单及完整摘要复用。
- `src/client/entry.css`：同排布局、菜单摘要和有任务时的响应式适配。
- `README.md`、`README.zh.md`、`README.i18n.yaml`：布局说明与翻译配对记录。
- `openspec/changes/visual-curator-search-feedback/design.md` 及 `specs/visual-curator-search-feedback/spec.md`：既有变更的展示要求。
- 本文：修改范围、产物更新及回滚位置。

修改前副本与范围记录位于 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-header-task-20261029/`，回滚时只恢复本轮差异，保留此前及其他会话的修改。
