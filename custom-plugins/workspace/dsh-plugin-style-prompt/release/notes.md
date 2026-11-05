## Style Prompt 0.2.0

Style Prompt adds a persistent node canvas for reference images, style analysis, selected rules, scenes, bilingual prompts and image output. Branches reuse unchanged upstream analysis, run independently and retain frozen inputs, history, cancellation and restart recovery. Keyboard editing, autosave, undo/redo, branch duplication and canvas import/export use the existing application controls and theme.

Image generation uses explicitly advertised models from the native LLM image API, including the updated Codex Subscription provider. Install AutoFlow Desktop 0.2.2-rc.1.20261105.3 for that API; older Hosts report unavailable image generation without losing saved canvases. Existing analyses and prompts remain readable and can open as an additive canvas. No separate ComfyUI service is required, and this canvas does not execute ComfyUI workflow files.

Update after current work finishes and restart AutoFlow. Saved profile data and activation choices remain. Image quality and paid-provider availability require separate real-service evaluation. Automatic installation remains opt-in.

## 风格提示词 0.2.0

新增持久化节点画布，连接参考图、风格分析、采用规则、新场景、双语提示词和图片输出。分支复用未变化的上游分析，独立运行，并保留固定输入、历史、取消与重启恢复。键盘编辑、自动保存、撤销重做、分支复制及画布导入导出沿用应用控件和主题。

生图通过原生 LLM 图片接口明确公布的模型执行，包括更新后的 Codex 订阅提供方。该接口需要本次 AutoFlow Desktop 0.2.2-rc.1.20261105.3；旧宿主会明确显示生图能力不可用，保留已有画布。原分析及提示词历史保持可读，可另建画布接入；无需额外 ComfyUI 服务，也不执行 ComfyUI 工作流文件。

在当前工作结束后更新并重启 AutoFlow，保留 profile 数据和启用选择。图片质量与付费提供方可用性需另行实测。自动安装仍需明确开启。
