# 会话找图卡片交付

当前实现将完整找图卡片从工具过程抽出，放到会话 body 右上角、原生任务胶囊下方。二者注册到同一个 `conversation.body.overlay`，按 order 0、30 纵向排列；胶囊展开时由布局自然推开下方卡片。卡片复用项目的 Button、Menu/SelectField、StateDot、AnimatedCollapse、图标及语义主题 token，使用任务胶囊相同的菜单材质与侧边空间显示条件。

过程内仅保留工具回执和原始详情；会话内多个找图、裁图在一张卡片中独立切换，状态和数量不合并。已有 Session 授权、历史恢复、断线保留和交付回执读取继续使用插件的任务观察服务。

用户要求直接修改并自行手动测试，因此停止自动测试与浏览器验证。用户手测发现位置仍在下方后，定位到源码已改为 body overlay，但实际 `client.js` 仍注册 input dock，共享会话布局的产物也未更新；随后仅运行插件 `scripts/build.mjs` 和 ui-conversation 的 `bundle`，更新实际加载文件，没有重新运行测试。此前输入框上方版本的结果不能作为当前定位的验收结论；对应 GUI 检查和临时验证服务器已停止。当前已打开页面需重新加载客户端脚本。

修改集中在 Visual Curator 客户端及其 Session 只读任务发现接口、共享 body overlay 的纵向布局和说明文档；未提交或推送。本轮修改前副本和范围记录位于 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-conversation-dock-20261029/`，回滚时仅审查并还原本轮差异，保留其他会话已有修改。

手动查看时，侧边空白达到原生任务胶囊的 280px 显示条件后，找图卡应位于其下方；展开任一卡片应自然排列，关闭工具过程应不影响找图卡。空间不足时两者均按原有侧边空白规则隐藏，可从工作台查看任务。

## 卡片样式与宽度

卡片改为标题及原生状态标签、单次需求说明、突出最终入选的数量区、操作区和可展开图库。阶段与数据新鲜度单独排列；图片保留完整比例，分类使用项目 Tag 色板，零值技术提示不占行。使用既有 Button、Tag、StateDot、Tooltip、AnimatedCollapse、Menu/SelectField、图标及主题 token。

左侧手柄通过 pointer capture 调整卡片自身宽度，范围 280–640px 并受会话尺寸限制；默认 300px，右边缘固定，上方任务胶囊最大保持 300px。双击恢复默认，左右方向键和 Home、End 可调整，取消手势恢复原宽度。共享 overlay 拆分为保留侧边空白显示条件的外层与按内容宽度靠右排列的内部列，允许单张卡片向左扩宽。宽度只属于当前会话组件，切换任务时保留，重新挂载或切换会话时使用默认值。

本轮只重新生成 Visual Curator 和 ui-conversation 的客户端产物，并更新双语说明记录；遵照用户要求未运行自动测试、类型检查或浏览器验证。样式和拖拽由用户刷新页面后手动确认。

本次修改前副本及范围记录位于 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-task-card-resize-20261029/`。源文件主要为 `conversation-task-dock.tsx`、插件 `entry.css`/locale、ConversationContent/ConversationRoot 与 TodoPanel 的布局样式，相关说明同步更新；未提交或推送，回滚仅还原本轮差异。
