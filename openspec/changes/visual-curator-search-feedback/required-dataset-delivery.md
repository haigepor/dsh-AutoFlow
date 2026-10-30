# 找图数据集必选

新建找图任务在画像简介下增加“数据集 *”。只列出当前素材集和当前画像对应的已完成共享数据包，支持分页、查看详情和前往生成；选中后显示参考图数量、规则数量与生成时间。未选择或数据集列表加载失败时禁用开始按钮。查看或生成数据集时保留当前表单，点击“按此画像找图”回到原草稿并刷新选择列表。

后端在创建原生会话前检查所选 exportId 的账户、会话访问、画像及分析身份、必要文件、校验和和包内画像摘要。数据集身份写入启动输入及 Launch；新启动不再自动生成或替换包。输入字段对已保存记录仍可选，旧任务请求摘要和绑定不变，尚未完成的已受理准备继续原流程。

修改文件与用途：

- `src/shared/search-launch.ts`：新增可兼容旧记录的数据集身份。
- `src/shared/datasets.ts`、`src/host/datasets.ts`：分页前按画像和可复用成品筛选目录。
- `src/host/search-launch.ts`：新启动强制选择、文件检查和持久绑定，保留旧任务恢复。
- `src/client/search-launch-store.ts`：独立的选择目录、分页、加载错误及过期响应隔离。
- `src/client/search-launch-dialog.tsx`、`src/client/entry.css`：必选字段、摘要、详情／生成入口和紧凑表单。
- `src/client/workbench.tsx`：导航至数据集时保留原表单。
- `src/client/search-feedback-locale.ts`、`src/client/workbench-locale.ts`：中英文提示。
- `README.md`、`README.zh.md`、`README.i18n.yaml` 和本变更的 design/spec/tasks：行为及兼容性说明。

用户要求不运行自动测试、类型检查或浏览器验证；运行效果由用户手动确认。已执行插件 `node scripts/build.mjs` 更新前后端加载产物，返回码为 0；README 配对记录只执行 `--write` 生成。未提交或推送，未重启任务、改写用户数据或调用付费服务。已运行的 Host 需要重新加载插件代码后使用新校验。

回滚位置为 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-required-dataset-20261029/`，其中 before/ 保存修改前字节。仅恢复本轮差异，保留已有共享修改和任务数据。
