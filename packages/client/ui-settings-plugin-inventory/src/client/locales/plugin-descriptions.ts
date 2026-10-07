/** Locale-owned concise descriptions for the built-in plugin inventory. */
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'

/** Reviewed built-in inventory descriptions in both supported languages. */
export const inventoryDescriptions: Readonly<Record<string, LocalizedText>> = {
  '@deepseek-ai/dsh-persona': {
    'en': "Set the current Agent's persona and prompt.",
    'zh': '设置当前 Agent 的身份和提示词。',
  },
  '@deepseek-ai/dsh-agent-instructions': {
    'en': 'Load and refresh workspace AGENTS.md instructions.',
    'zh': '加载并刷新工作区的 AGENTS.md 指令。',
  },
  '@deepseek-ai/dsh-tool-bash': {
    'en': 'Run Bash commands with background-job support.',
    'zh': '执行 Bash 命令，支持后台任务。',
  },
  '@deepseek-ai/dsh-tool-pwsh': {
    'en': 'Run PowerShell commands with background-job support.',
    'zh': '执行 PowerShell 命令，支持后台任务。',
  },
  '@deepseek-ai/dsh-tool-fs': {
    'en': 'Read files and images, write or edit files.',
    'zh': '读取文件和图片，写入或编辑文件。',
  },
  '@deepseek-ai/dsh-tool-fs-search': {
    'en': 'Find workspace files by path or content.',
    'zh': '按路径或内容搜索工作区文件。',
  },
  '@deepseek-ai/dsh-tool-jobs': {
    'en': 'Inspect background jobs and output, or stop jobs.',
    'zh': '查看后台任务及输出，停止运行中的任务。',
  },
  '@deepseek-ai/dsh-skill-filesystem': {
    'en': 'Discover and load project and user Skills.',
    'zh': '发现并加载项目和用户目录中的 Skills。',
  },
  '@deepseek-ai/dsh-tool-skill': {
    'en': 'Expose the Skill catalog and loading tool.',
    'zh': '向 Agent 提供 Skill 目录和加载工具。',
  },
  '@deepseek-ai/dsh-command-goal': {
    'en': 'Manage session goals through /goal.',
    'zh': '通过 /goal 命令管理当前会话目标。',
  },
  '@deepseek-ai/dsh-tool-goal': {
    'en': 'Let Agents create, read and update session goals.',
    'zh': '让 Agent 创建、读取和更新会话目标。',
  },
  '@deepseek-ai/dsh-tool-ask-user': {
    'en': 'Ask the user a question and await an answer.',
    'zh': '向用户提问并等待回答。',
  },
  '@deepseek-ai/dsh-tool-todo': {
    'en': 'Record and update the session task list.',
    'zh': '记录并更新当前会话的任务清单。',
  },
  '@deepseek-ai/dsh-tool-web': {
    'en': 'Let Agents search and fetch web pages.',
    'zh': '让 Agent 搜索网页和读取网页内容。',
  },
  '@deepseek-ai/dsh-agent-tool-presentation': {
    'en': 'Select native tools, PTC, or both for the model.',
    'zh': '选择向模型展示原生工具、PTC 或两者。',
  },
  '@deepseek-ai/dsh-tool-present': {
    'en': 'Present workspace files as accessible deliverables.',
    'zh': '将工作区文件声明为可打开的交付成果。',
  },
  '@deepseek-ai/dsh-plugin-manager/tools': {
    'en': 'Let Agents manage profile plugins and bundles.',
    'zh': '让 Agent 管理当前配置的插件和扩展包。',
  },
  '@deepseek-ai/dsh-plan-mode': {
    'en': 'Provide plan mode, plan review and /plan.',
    'zh': '提供计划模式、计划审核和 /plan 命令。',
  },
  '@deepseek-ai/dsh-compaction-basic': {
    'en': 'Summarize older history as context fills.',
    'zh': '在上下文接近容量时总结较早的对话。',
  },
  '@deepseek-ai/dsh-command-compact': {
    'en': 'Manually compact session context with /compact.',
    'zh': '通过 /compact 手动压缩会话上下文。',
  },
  '@deepseek-ai/dsh-compaction-tool-result-pruner': {
    'en': 'Trim oversized tool output while retaining key excerpts.',
    'zh': '缩短过长的工具输出，保留关键片段。',
  },
  '@deepseek-ai/dsh-tool-subagent-control': {
    'en': 'Message child Agents or interrupt their tasks.',
    'zh': '向子 Agent 发消息或中断其任务。',
  },
  '@deepseek-ai/dsh-tool-subagent-control/list-agents': {
    'en': 'List child Agents and their current status.',
    'zh': '列出子 Agent 及其当前状态。',
  },
  '@deepseek-ai/dsh-tool-subagent': {
    'en': 'Delegate tasks to a configured child Agent.',
    'zh': '将任务委派给指定的子 Agent。',
  },
  '@deepseek-ai/dsh-workflow-ptc': {
    'en': 'Orchestrate workflows in a sandboxed Node process.',
    'zh': '在沙箱 Node 进程中编排工作流。',
  },
  '@deepseek-ai/dsh-tool-workflow': {
    'en': 'Run JavaScript scripts to orchestrate Agents.',
    'zh': '运行 JavaScript 脚本编排多个 Agent。',
  },
  '@deepseek-ai/dsh-tool-ralph': {
    'en': 'Iterate toward one objective with fresh Agents.',
    'zh': '让全新 Agent 逐轮推进同一个目标。',
  },
  '@deepseek-ai/dsh-plugin-manager': {
    'en': 'Install, remove and select profile bundles.',
    'zh': '安装、移除和切换当前配置的扩展包。',
  },
  '@deepseek-ai/dsh-hmr': {
    'en': 'Coordinate plugin-code and configuration reloads.',
    'zh': '协调插件代码和配置的热更新。',
  },
  '@deepseek-ai/dsh-llm': {
    'en': 'Provide a common request and response interface for LLMs.',
    'zh': '统一模型提供商的请求和响应接口。',
  },
  '@deepseek-ai/dsh-deepseek-llm-api-extensions': {
    'en': 'Register additional fields for official DeepSeek requests.',
    'zh': '向官方 DeepSeek 请求注册扩展字段。',
  },
  '@deepseek-ai/dsh-session': {
    'en': 'Record and replay session events and state.',
    'zh': '记录并重放会话事件和状态。',
  },
  '@deepseek-ai/dsh-session-log-deepseek': {
    'en': 'Upload incremental session logs with official DeepSeek requests.',
    'zh': '随官方 DeepSeek 请求增量上传会话日志。',
  },
  '@deepseek-ai/dsh-typert-registry': {
    'en': 'Register generated type reflection and validation schemas.',
    'zh': '注册生成的类型反射信息和数据校验规则。',
  },
  '@deepseek-ai/dsh-typert-loader': {
    'en': 'Register type metadata as plugins load and unload.',
    'zh': '随插件加载和卸载注册类型信息。',
  },
  '@deepseek-ai/dsh-api-gateway': {
    'en': 'Dispatch Host Remote calls and expose the Client endpoint.',
    'zh': '分发 Host Remote 调用并提供客户端入口。',
  },
  '@deepseek-ai/dsh-session-title': {
    'en': 'Manage session titles and title providers.',
    'zh': '管理会话标题和标题生成服务。',
  },
  '@deepseek-ai/dsh-session-title-first-prompt-llm': {
    'en': 'Generate session titles from the first user message.',
    'zh': '根据首条用户消息生成会话标题。',
  },
  '@deepseek-ai/dsh-user-questions': {
    'en': 'Connect Agent questions to human answers.',
    'zh': '连接 Agent 提问和用户回答流程。',
  },
  '@deepseek-ai/dsh-agent': {
    'en': 'Manage Agent instances, scopes and lifecycle events.',
    'zh': '管理 Agent 实例、作用域和生命周期事件。',
  },
  '@deepseek-ai/dsh-plugin-package-inventory-deepseek': {
    'en': 'Attach the loaded plugin inventory to official DeepSeek requests.',
    'zh': '向官方 DeepSeek 请求提供已加载插件清单。',
  },
  '@deepseek-ai/dsh-agent-default-model': {
    'en': 'Select the default model for new Agents.',
    'zh': '为新的 Agent 选择默认模型。',
  },
  '@deepseek-ai/dsh-jobs-local': {
    'en': 'Track local background processes and results.',
    'zh': '跟踪本地后台进程及其执行结果。',
  },
  '@deepseek-ai/dsh-llm-retry': {
    'en': 'Retry failed requests using provider-specific policies.',
    'zh': '按模型提供商策略重试失败的请求。',
  },
  '@deepseek-ai/dsh-config-editor': {
    'en': 'Persist plugin configuration patches and reconcile the Loader.',
    'zh': '将插件配置保存为补丁并同步加载器。',
  },
  '@deepseek-ai/dsh-settings': {
    'en': 'Provide user-settings read and update interfaces.',
    'zh': '提供用户设置的读取和更新接口。',
  },
  '@deepseek-ai/dsh-authorization': {
    'en': 'Manage human-assisted credential authorization flows.',
    'zh': '管理需要用户参与的凭证授权流程。',
  },
  '@deepseek-ai/dsh-deepseek-account-platform': {
    'en': 'Sign in to DeepSeek accounts through browser PKCE.',
    'zh': '通过浏览器 PKCE 登录 DeepSeek 账号。',
  },
  '@deepseek-ai/dsh-credentials-local': {
    'en': 'Read environment credentials and store writable local keys.',
    'zh': '读取环境凭证并保存本地可写密钥。',
  },
  '@deepseek-ai/dsh-llm-pi-ai': {
    'en': 'Connect DeepSeek models through pi-ai.',
    'zh': '通过 pi-ai 连接 DeepSeek 模型服务。',
  },
  '@deepseek-ai/dsh-session-persistence-jsonl': {
    'en': 'Persist session events in JSONL files.',
    'zh': '将会话事件持久化为 JSONL 文件。',
  },
  '@deepseek-ai/dsh-attachment-local': {
    'en': 'Store content-addressed attachments in private local storage.',
    'zh': '在本地私有目录保存按内容索引的附件。',
  },
  '@deepseek-ai/dsh-session-query-sqlite': {
    'en': 'Index and search sessions with SQLite full-text search.',
    'zh': '使用 SQLite 索引和全文检索会话。',
  },
  '@deepseek-ai/dsh-session-projection': {
    'en': 'Project session logs into readable current state.',
    'zh': '将会话日志转换为可读取的当前状态。',
  },
  '@deepseek-ai/dsh-storage': {
    'en': 'Manage named storage backends and data facilities.',
    'zh': '管理命名存储后端和数据服务。',
  },
  '@deepseek-ai/dsh-storage-json': {
    'en': 'Store key-value data in JSON files.',
    'zh': '使用 JSON 文件保存键值数据。',
  },
  '@deepseek-ai/dsh-storage-domain': {
    'en': 'Validate stored domain data and publish change events.',
    'zh': '对存储数据进行校验并发布变更事件。',
  },
  '@deepseek-ai/dsh-session-projection-cache': {
    'en': 'Cache session projections to reduce repeated replay.',
    'zh': '缓存会话状态，减少重复日志重放。',
  },
  '@deepseek-ai/dsh-otel': {
    'en': 'Provide OTLP channels for events and session logs.',
    'zh': '提供普通事件和会话日志的 OTLP 上报通道。',
  },
  '@deepseek-ai/dsh-session-telemetry-otel': {
    'en': 'Send feedback-authorized session logs to telemetry.',
    'zh': '按反馈授权将会话日志发送到遥测服务。',
  },
  '@deepseek-ai/dsh-subprocess-local': {
    'en': 'Launch and manage local subprocesses.',
    'zh': '启动并管理本地子进程。',
  },
  '@deepseek-ai/dsh-sandbox-local': {
    'en': 'Constrain local processes with OS sandbox backends.',
    'zh': '通过操作系统沙箱限制本地进程。',
  },
  '@deepseek-ai/dsh-sandbox-policy': {
    'en': 'Resolve sandbox mode and workspace limits per call.',
    'zh': '解析每次调用的沙箱模式和工作区限制。',
  },
  '@deepseek-ai/dsh-bash-sandbox': {
    'en': 'Run Bash commands under sandbox restrictions.',
    'zh': '在沙箱限制下执行 Bash 命令。',
  },
  '@deepseek-ai/dsh-pwsh-sandbox': {
    'en': 'Run PowerShell commands under sandbox restrictions.',
    'zh': '在沙箱限制下执行 PowerShell 命令。',
  },
  '@deepseek-ai/dsh-user-approval': {
    'en': 'Request and resolve one-time human approvals.',
    'zh': '请求并处理一次性的用户权限批准。',
  },
  '@deepseek-ai/dsh-permission-presets': {
    'en': 'Combine sandbox and approval policies into permission presets.',
    'zh': '组合沙箱和审批策略为可切换权限预设。',
  },
  '@deepseek-ai/dsh-shell-env': {
    'en': 'Manage DSH environment variables shared by tools.',
    'zh': '统一管理工具使用的 DSH 环境变量。',
  },
  '@deepseek-ai/dsh-fs-observation-policy': {
    'en': 'Check prior reads and file versions before mutations.',
    'zh': '检查读取记录和文件版本，防止覆盖过期内容。',
  },
  '@deepseek-ai/dsh-skill': {
    'en': 'Register Skill providers for Agents.',
    'zh': '注册可供 Agent 使用的 Skill 来源。',
  },
  '@deepseek-ai/dsh-skill-badge': {
    'en': 'Provide the bundled DSH badge Skill.',
    'zh': '提供随应用附带的 DSH badge Skill。',
  },
  '@deepseek-ai/dsh-commands': {
    'en': 'Register human-facing plugin commands.',
    'zh': '注册面向用户的插件命令。',
  },
  '@deepseek-ai/dsh-command-feedback': {
    'en': 'Record session feedback submitted through /feedback.',
    'zh': '记录 /feedback 命令提交的会话反馈。',
  },
  '@deepseek-ai/dsh-goal': {
    'en': 'Persist session goals and their lifecycle.',
    'zh': '持久化当前会话目标及其生命周期。',
  },
  '@deepseek-ai/dsh-goal-round-driver': {
    'en': 'Continue session execution according to goal state.',
    'zh': '按目标状态继续驱动同一会话执行。',
  },
  '@deepseek-ai/dsh-token-meter': {
    'en': 'Measure context tokens from replayed session state.',
    'zh': '根据会话重放结果统计上下文 token 用量。',
  },
  '@deepseek-ai/dsh-subagent': {
    'en': 'Register and coordinate child-Agent providers.',
    'zh': '注册并协调不同的子 Agent 执行方式。',
  },
  '@deepseek-ai/dsh-subagent-spawn-in-process': {
    'en': 'Start fresh-context child Agents in the current process.',
    'zh': '在当前进程中启动独立上下文的子 Agent。',
  },
  '@deepseek-ai/dsh-subagent-fork-in-process': {
    'en': 'Create child Agents from a prefix of parent history.',
    'zh': '从父会话的历史片段创建子 Agent。',
  },
  '@deepseek-ai/dsh-ptc-runtime-node': {
    'en': 'Provide a sandboxed Node runtime for tool orchestration.',
    'zh': '提供用于工具编排的沙箱 Node 执行环境。',
  },
  '@deepseek-ai/dsh-tool-call-timeout-policy': {
    'en': 'Apply tool-call deadlines and cancel timed-out execution.',
    'zh': '为工具调用设置期限并中止超时执行。',
  },
  '@deepseek-ai/dsh-spill-local': {
    'en': 'Store oversized output in private session files.',
    'zh': '将过长输出保存为会话专属本地文件。',
  },
  '@deepseek-ai/dsh-spill-policy': {
    'en': 'Retain output within token budgets with recovery paths.',
    'zh': '按 token 预算保留输出并提供恢复路径。',
  },
  '@deepseek-ai/dsh-session-checkpoint-policy': {
    'en': 'Checkpoint sessions before model requests and tool side effects.',
    'zh': '在模型请求和工具副作用前保存会话检查点。',
  },
  '@deepseek-ai/dsh-compaction-image-offload': {
    'en': 'Offload over-budget request images into recoverable references.',
    'zh': '将超出请求预算的图片卸载为可恢复引用。',
  },
  '@deepseek-ai/dsh-repeat-tool-reminder': {
    'en': 'Warn about repeated identical tool calls.',
    'zh': '对反复相同的工具调用发出提示。',
  },
  '@deepseek-ai/dsh-web': {
    'en': 'Register web-search and fetch providers.',
    'zh': '注册网页搜索和抓取服务。',
  },
  '@deepseek-ai/dsh-web-search-deepseek': {
    'en': "Search the web using DeepSeek's native capability.",
    'zh': '使用 DeepSeek 原生能力搜索网页。',
  },
  '@deepseek-ai/dsh-web-fetch-http': {
    'en': 'Fetch public web content over HTTP.',
    'zh': '通过 HTTP 读取公开网页内容。',
  },
  '@deepseek-ai/dsh-mcp-resources': {
    'en': 'Discover and read scoped MCP resources.',
    'zh': '发现并读取当前作用域的 MCP 资源。',
  },
  '@deepseek-ai/dsh-tools': {
    'en': 'Register tools and dispatch their execution pipeline.',
    'zh': '注册工具并调度其执行流程。',
  },
  '@deepseek-ai/dsh-system-prompt': {
    'en': 'Assemble system-prompt sections contributed by plugins.',
    'zh': '组合各插件提供的系统提示词片段。',
  },
  '@deepseek-ai/dsh-agent-loop': {
    'en': 'Drive model requests, tool calls and Agent execution.',
    'zh': '驱动模型请求、工具调用和会话执行。',
  },
  '@deepseek-ai/dsh-fs-sandbox': {
    'en': 'Restrict file writes and edits according to sandbox mode.',
    'zh': '按沙箱模式限制文件写入和编辑范围。',
  },
  '@deepseek-ai/dsh-llm-deepseek-api-key': {
    'en': 'Authenticate and discover DeepSeek models using API keys.',
    'zh': '使用 API 密钥认证并发现 DeepSeek 模型。',
  },
  '@deepseek-ai/dsh-llm-deepseek-account': {
    'en': 'Authenticate and discover DeepSeek models using account credentials.',
    'zh': '使用账号凭证认证并发现 DeepSeek 模型。',
  },
  '@deepseek-ai/dsh-host-product-telemetry-otel': {
    'en': 'Export product usage events through OpenTelemetry.',
    'zh': '通过 OpenTelemetry 上报产品使用事件。',
  },
  '@deepseek-ai/dsh-client-product-analytics': {
    'en': 'Collect Client usage events and report them to the Host.',
    'zh': '收集客户端使用事件并提交到 Host。',
  },
  '@deepseek-ai/dsh-tool-subagent/model-selection-settings': {
    'en': 'Configure model routes available to child Agents.',
    'zh': '配置子 Agent 可选择的模型路由。',
  },
  '@deepseek-ai/dsh-message-feedback': {
    'en': 'Record ratings and notes for assistant messages.',
    'zh': '记录助手消息的评分和反馈备注。',
  },
  '@deepseek-ai/dsh-session-log-export': {
    'en': 'Provide session-log export and download controls.',
    'zh': '提供会话日志导出和下载入口。',
  },
  '@deepseek-ai/dsh-host-open-in-app': {
    'en': 'Discover local applications and open workspaces or files.',
    'zh': '发现本地应用并打开工作区或文件。',
  },
  '@deepseek-ai/dsh-client-ui-open-in-app': {
    'en': 'Show application-opening controls for workspaces and files.',
    'zh': '显示工作区和文件的“打开方式”入口。',
  },
  '@deepseek-ai/dsh-workspace': {
    'en': 'Persist workspace records and attach sessions.',
    'zh': '保存工作区记录并关联会话。',
  },
  '@deepseek-ai/dsh-session-reference': {
    'en': 'Expose other session snapshots as labeled reference context.',
    'zh': '将其他会话的快照作为明确标记的引用上下文。',
  },
  '@deepseek-ai/dsh-file-reference-local': {
    'en': 'Provide local fuzzy-search indexes for file references.',
    'zh': '为文件引用提供本地模糊搜索索引。',
  },
  '@deepseek-ai/dsh-session-stats': {
    'en': 'Project conversation counts and execution times.',
    'zh': '统计会话消息数量和执行时长。',
  },
  '@deepseek-ai/dsh-session-turn-outline': {
    'en': 'Project a turn-by-turn session outline.',
    'zh': '生成按轮次组织的会话提纲。',
  },
  '@deepseek-ai/dsh-host-directory-picker-auto': {
    'en': 'Choose a native or in-page directory picker at startup.',
    'zh': '根据运行环境选择原生或页面目录选择器。',
  },
  '@deepseek-ai/dsh-host-plugin-inventory': {
    'en': 'Read current plugin configuration and loading state.',
    'zh': '只读查询当前插件配置和加载状态。',
  },
  '@deepseek-ai/dsh-api-session-controller': {
    'en': 'Expose session reads, commands and live controls.',
    'zh': '提供会话读取、命令和实时控制接口。',
  },
  '@deepseek-ai/dsh-api-job-controller': {
    'en': 'Expose job observation and output subscriptions.',
    'zh': '提供后台任务观察和输出订阅接口。',
  },
  '@deepseek-ai/dsh-api-terminal-controller': {
    'en': 'Manage session terminals, shell discovery and screen recovery.',
    'zh': '管理会话终端、Shell 发现和屏幕恢复。',
  },
  '@deepseek-ai/dsh-api-workspace-files': {
    'en': 'Expose file reads, directory listings and live metadata.',
    'zh': '提供文件读取、目录列表和实时元数据。',
  },
  '@deepseek-ai/dsh-client-ui-settings-account': {
    'en': 'Manage DeepSeek sign-in and open billing pages.',
    'zh': '管理 DeepSeek 登录并打开账单页面。',
  },
  '@deepseek-ai/dsh-api-account-controller': {
    'en': 'Expose authenticated, safe account operations.',
    'zh': '提供经过认证的安全账号操作接口。',
  },
  '@deepseek-ai/dsh-api-settings-controller': {
    'en': 'Expose settings reads and writes to Clients.',
    'zh': '向客户端提供设置读取和保存接口。',
  },
  '@deepseek-ai/dsh-api-workspace-controller': {
    'en': 'Expose workspace commands and reconnect-safe state.',
    'zh': '提供工作区命令及断线重连后的状态同步。',
  },
  '@deepseek-ai/dsh-cordis-host-runner': {
    'en': 'Manage Host execution of dynamic dual-face plugins.',
    'zh': '管理动态双端插件的 Host 执行生命周期。',
  },
  '@deepseek-ai/dsh-tool-cordis/host': {
    'en': 'Inspect runtime APIs for plugin development without mutations.',
    'zh': '只读检查插件开发所需的运行时 API。',
  },
  '@deepseek-ai/dsh-web-app/startup': {
    'en': 'Initialize Web application startup configuration.',
    'zh': '初始化 Web 应用的启动配置。',
  },
  '@deepseek-ai/dsh-host-webserver': {
    'en': 'Register HTTP routes and serve frontend assets.',
    'zh': '注册 HTTP 路由并提供前端静态资源。',
  },
  '@deepseek-ai/dsh-web-app': {
    'en': 'Connect the Web surface, runtime guidance and assets.',
    'zh': '连接 Web 页面、运行时提示词和应用资源。',
  },
  '@deepseek-ai/dsh-client-hmr': {
    'en': 'Synchronize the Client graph and reload rebuilt modules.',
    'zh': '同步客户端插件图并加载重建后的模块。',
  },
  '@deepseek-ai/dsh-client-modules': {
    'en': 'Load Client plugin modules and assemble the boot graph.',
    'zh': '加载客户端插件模块并生成启动依赖图。',
  },
  '@deepseek-ai/dsh-client-connection': {
    'en': 'Manage authenticated RPC connections and lifecycle.',
    'zh': '管理认证 RPC 连接及其生命周期。',
  },
  '@deepseek-ai/dsh-client-file-upload': {
    'en': 'Upload browser files and stage attachment receipts.',
    'zh': '上传浏览器文件并暂存附件接收记录。',
  },
  '@deepseek-ai/dsh-api-remotes': {
    'en': 'Assemble Host Remote capabilities for the application.',
    'zh': '组合应用所需的 Host Remote 能力。',
  },
  '@deepseek-ai/dsh-cordis-client-runner': {
    'en': 'Run dynamic dual-face plugins in the browser.',
    'zh': '在浏览器中运行动态双端插件。',
  },
  '@deepseek-ai/dsh-client-ui-theme': {
    'en': 'Manage light, dark and system themes and color tokens.',
    'zh': '管理浅色、深色及系统主题和颜色变量。',
  },
  '@deepseek-ai/dsh-client-locale': {
    'en': 'Manage language preferences and typed locale dictionaries.',
    'zh': '管理语言偏好和类型化多语言文案。',
  },
  '@deepseek-ai/dsh-client-shortcuts': {
    'en': 'Register shortcuts and route keyboard commands.',
    'zh': '注册快捷键并分发键盘命令。',
  },
  '@deepseek-ai/dsh-client-ui-shortcuts': {
    'en': 'View, record and edit keyboard shortcuts.',
    'zh': '查看、录制和编辑键盘快捷键。',
  },
  '@deepseek-ai/dsh-client-ui-layout': {
    'en': 'Manage the three-column layout and panel navigation.',
    'zh': '管理应用三栏布局和面板导航状态。',
  },
  '@deepseek-ai/dsh-client-ui-renderer': {
    'en': 'Render plugin slots as the React application.',
    'zh': '将插件插槽组合为 React 应用界面。',
  },
  '@deepseek-ai/dsh-client-ui-session': {
    'en': 'Connect session controllers to React session slots.',
    'zh': '连接会话控制器与 React 会话插槽。',
  },
  '@deepseek-ai/dsh-client-resources': {
    'en': 'Resolve resource addresses into subscribable live values.',
    'zh': '将资源地址解析为可订阅的实时数据。',
  },
  '@deepseek-ai/dsh-client-ui-sidebar': {
    'en': 'Show session trees, search, grouping and state markers.',
    'zh': '显示会话树、搜索、分组和状态标记。',
  },
  '@deepseek-ai/dsh-client-ui-sidebar-right': {
    'en': 'Manage session-bound right panels and their disclosures.',
    'zh': '管理会话右侧面板和展开收起操作。',
  },
  '@deepseek-ai/dsh-office-to-pdf': {
    'en': 'Queue Office-to-PDF conversions and cache results.',
    'zh': '排队转换 Office 文档并缓存 PDF。',
  },
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview': {
    'en': 'Preview documents, spreadsheets, code, images and PDFs.',
    'zh': '预览文档、表格、代码、图片和 PDF。',
  },
  '@deepseek-ai/dsh-client-ui-sidebar-browser': {
    'en': 'Show sandboxed browser tabs in the right panel.',
    'zh': '在右侧面板显示沙箱网页标签。',
  },
  '@deepseek-ai/dsh-client-ui-sidebar-terminal': {
    'en': 'Show interactive terminals in the right panel.',
    'zh': '在右侧面板显示交互式终端。',
  },
  '@deepseek-ai/dsh-client-ui-sidebar-files': {
    'en': 'Lazily load workspace file trees and open files.',
    'zh': '按需加载工作区文件树并打开文件。',
  },
  '@deepseek-ai/dsh-client-ui-settings': {
    'en': 'Provide settings slots and shared configuration forms.',
    'zh': '提供设置页插槽和共享配置表单。',
  },
  '@deepseek-ai/dsh-client-ui-settings-general': {
    'en': 'Show General settings, settings chrome and welcome notices.',
    'zh': '显示通用设置、设置页入口和首次欢迎提示。',
  },
  '@deepseek-ai/dsh-client-ui-settings-models': {
    'en': 'Manage model providers, credentials and model catalogs.',
    'zh': '管理模型提供商、凭证和模型目录。',
  },
  '@deepseek-ai/dsh-client-ui-plugin-manager': {
    'en': 'Install, enable, disable, retry and compose plugin packages.',
    'zh': '安装、启停、重试和组合插件包。',
  },
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory': {
    'en': 'Show the read-only plugin inventory grouped by scope.',
    'zh': '显示按作用域分组的只读插件清单。',
  },
  '@deepseek-ai/dsh-client-ui-conversation': {
    'en': 'Assemble conversation pages, composer, queues and navigation.',
    'zh': '组合会话页面、输入区、队列和视图导航。',
  },
  '@deepseek-ai/dsh-client-ui-approval': {
    'en': 'Present permission approval requests in the composer.',
    'zh': '在输入区展示权限审批请求。',
  },
  '@deepseek-ai/dsh-client-ui-chat': {
    'en': 'Render chat messages, conversation nodes and details.',
    'zh': '渲染聊天消息、会话节点和详情。',
  },
  '@deepseek-ai/dsh-client-ui-brand-official': {
    'en': 'Contribute official brand artwork to sidebar slots.',
    'zh': '为侧边栏提供官方品牌标识。',
  },
  '@deepseek-ai/dsh-client-ui-attachment': {
    'en': 'Present attachments and images in inputs and messages.',
    'zh': '展示输入区和消息中的附件与图片。',
  },
  '@deepseek-ai/dsh-client-ui-tool': {
    'en': 'Render tool-call trees and tool-specific result cards.',
    'zh': '渲染工具调用树及工具专属结果卡片。',
  },
  '@deepseek-ai/dsh-client-ui-cordis': {
    'en': 'Present dynamic plugin definitions with run and stop controls.',
    'zh': '展示动态插件定义及运行停止操作。',
  },
  '@deepseek-ai/dsh-client-ui-deliverables': {
    'en': 'Present deliverables, file comparisons and clickable references.',
    'zh': '展示交付文件、文件比较和可点击引用。',
  },
  '@deepseek-ai/dsh-workspace-changes': {
    'en': 'Record per-turn file changes and produce comparisons.',
    'zh': '按会话轮次记录文件变更并生成比较结果。',
  },
  '@deepseek-ai/dsh-client-ui-workspace': {
    'en': 'Browse and manage workspaces, sessions and directory selection.',
    'zh': '浏览和管理工作区、会话及目录选择。',
  },
  '@deepseek-ai/dsh-client-ui-workflow-run': {
    'en': 'Present replayable workflow runs and nested members.',
    'zh': '展示可重放的工作流运行及嵌套成员。',
  },
  '@deepseek-ai/dsh-client-ui-input-trigger': {
    'en': 'Detect / and @ input triggers and show candidates.',
    'zh': '识别输入中的 / 和 @ 并显示候选菜单。',
  },
  '@deepseek-ai/dsh-client-ui-commands': {
    'en': 'Provide command candidates, popup choices and dispatch.',
    'zh': '提供命令候选、弹出选择和操作分发。',
  },
  '@deepseek-ai/dsh-client-ui-skill': {
    'en': 'Show Skill reference candidates and call cards.',
    'zh': '显示 Skill 引用候选和调用卡片。',
  },
  '@deepseek-ai/dsh-client-ui-subagent': {
    'en': 'Browse child-Agent sessions and compose addressed messages.',
    'zh': '浏览子 Agent 会话并发送定向消息。',
  },
  '@deepseek-ai/dsh-client-ui-reference': {
    'en': 'Reference files and other sessions in the composer.',
    'zh': '在输入框中引用文件和其他会话。',
  },
  '@deepseek-ai/dsh-client-ui-jobs': {
    'en': 'Show background-job lists and live output panels.',
    'zh': '显示后台任务列表和实时输出面板。',
  },
  '@deepseek-ai/dsh-client-ui-goal': {
    'en': 'Show the current goal with editing and lifecycle controls.',
    'zh': '显示当前目标并提供编辑和状态操作。',
  },
  '@deepseek-ai/dsh-client-ui-message-feedback': {
    'en': 'Show message ratings and session-feedback dialogs.',
    'zh': '显示消息评价和会话反馈弹窗。',
  },
  '@deepseek-ai/dsh-client-ui-model-selection': {
    'en': 'Select session models through a shared catalog.',
    'zh': '通过共享目录选择当前会话模型。',
  },
  '@deepseek-ai/dsh-client-ui-permission-presets': {
    'en': 'Set default and current-session permissions.',
    'zh': '设置默认权限及当前会话权限。',
  },
  '@deepseek-ai/dsh-client-ui-agent-preset': {
    'en': 'Select Agent presets and inspect guidance and configuration.',
    'zh': '选择 Agent 预设并查看模式说明和配置。',
  },
  '@deepseek-ai/dsh-client-ui-settings-session-log': {
    'en': 'Control session-log uploads with DeepSeek requests.',
    'zh': '设置 DeepSeek 请求是否上传会话日志。',
  },
  '@deepseek-ai/dsh-client-ui-settings-plugins': {
    'en': 'Provide built-in plugin settings and feature tabs.',
    'zh': '提供内置插件页及各功能标签入口。',
  },
  '@deepseek-ai/dsh-client-ui-settings-shell': {
    'en': 'Configure shell timeouts and output limits.',
    'zh': '配置命令超时和输出大小限制。',
  },
  '@deepseek-ai/dsh-client-ui-settings-agent-loop': {
    'en': 'Configure the parallel tool-call limit.',
    'zh': '配置工具调用的并行数量上限。',
  },
  '@deepseek-ai/dsh-client-ui-settings-subagent': {
    'en': 'Configure delegation depth, capacity and allowed models.',
    'zh': '配置委派深度、并发容量和可选模型。',
  },
  '@deepseek-ai/dsh-client-ui-settings-web-search': {
    'en': 'Configure web-search credentials, endpoint and budget.',
    'zh': '配置网页搜索密钥、地址和搜索预算。',
  },
  '@deepseek-ai/dsh-client-ui-plan': {
    'en': 'Show plan status, plan cards and Markdown previews.',
    'zh': '显示计划状态、计划卡片和 Markdown 预览。',
  },
  '@deepseek-ai/dsh-client-ui-user-questions': {
    'en': 'Present user questions and plan-review controls.',
    'zh': '显示用户问题和计划审核操作。',
  },
  '@deepseek-ai/dsh-client-ui-trajectory': {
    'en': 'Show session event ledgers and interactive timing.',
    'zh': '显示会话事件记录和交互式耗时概览。',
  },
  '@deepseek-ai/dsh-agent-preset-registry': {
    'en': 'Register preset compositions, session bindings and profile edits.',
    'zh': '注册预设组合并管理会话绑定和配置编辑。',
  },
  '@deepseek-ai/dsh-agent-preset': {
    'en': "Declare an Agent's tools, prompts and plugin composition.",
    'zh': '声明一个 Agent 的工具、提示词和插件组合。',
  },
  '@deepseek-ai/dsh-host-directory-picker-browse': {
    'en': 'Provide directory listings and creation for in-page picking.',
    'zh': '提供页面目录选择器的目录列表和创建接口。',
  },
  '@deepseek-ai/dsh-client-ui-directory-picker-browse': {
    'en': 'Browse directories and select workspaces in-page.',
    'zh': '在页面中浏览目录并选择工作区。',
  },
  'cordis:include': {
    'en': 'Load and compose external Cordis configuration files.',
    'zh': '加载并组合外部 Cordis 配置文件。',
  },
  '@deepseek-ai/cordis-plugin-timer': {
    'en': 'Provide disposal-aware timers, throttling and debouncing.',
    'zh': '提供随插件卸载释放的计时和防抖服务。',
  },
  'dshmarket': {
    'en': 'Browse the plugin marketplace and install plugins.',
    'zh': '浏览插件市场并安装插件。',
  },
}

/** Entry-specific descriptions for separately composed presets. */
export const presetEntryDescriptions: Readonly<Record<string, LocalizedText>> = {
  'preset-standard': { en: 'Compose the standard tools and context for general tasks.', zh: '组合常规任务所需的工具和上下文。' },
  'preset-ptc': { en: 'Compose tools with programmatic orchestration.', zh: '组合支持程序化工具编排的能力。' },
  'preset-minimal': { en: 'Compose the minimal terminal-focused Agent.', zh: '组合以终端工具为主的极简 Agent。' },
  'preset-cordis': { en: 'Compose runtime plugin-development capabilities.', zh: '组合运行时插件开发能力。' },
}
