# 自定义组合包架构

[English](architecture.md) | 中文

## Summary

自定义组合包是声明 `dsh.bundle.patch` 的 npm 包。profile 把它安装为依赖，并通过 patch 层选择 Cordis 行。[demo](demo/README.zh.md) 实现了可选内容注入、Host 操作、Agent 工具和 Client UI；复制模板时，这些能力都可以按需增减。

## 包结构与标识

每个 `custom-plugins/workspace/<name>/` 放一个独立版本的 npm 包。`workspace/` 是源码区域，不是 pnpm workspace，也不是可发布的包。`demo/` 保持为参考包，不与正式插件共享发布状态。每个包会发布 `package.json`、`cordis.patch.yml`、Host ESM 入口、可选 `client.js`、本地化 JSON、图标、资源与文档。所有运行文件必须列入 `files`，patch 行引用的模块都必须有明确 `exports`。不要新增应用 `bin`；受支持的 Node 应用只能由 DSH profile 启动。

复制 demo 时，应同步修改 npm `name`、patch 行的 `name`、Client 模块 `id`、UI 注册 `key`、Host 操作命名空间、提示词标记与私有归属目录、Skill 目录及 frontmatter `name`、图标、本地化内容和 peer 依赖。发布后尽量保持行 `id` 稳定，因为每个 profile 用行 ID 保存功能选择。必须修改行 ID 时，应提供迁移或在发布前说明选择会重置。

## 组合与功能选择

`dsh.bundle.patch` 指向 patch YAML；其中 `insert` 条目是可独立装载的 Cordis 行。根行可负责 Client UI 和管理操作，其他可选行分别负责提示词、Skill 和执行逻辑。每个注册都作为生命周期 effect，在所属行卸载时撤销。

`dsh.bundle.features` 是可选数组，每项为 `{ id, rowId, title, description, details?, kind?, defaultEnabled }`。功能 ID 与行 ID 必须唯一；`rowId` 必须指向唯一插入行，且其 `disabled` 值与 `defaultEnabled` 一致。`kind` 可为 `prompt`、`skill`、`script`、`ui` 或 `other`，插件页据此显示分类标题与图标；只有需要保留旧版平铺列表的既有功能才省略它。文案可为字符串，也可为含 `en` 的本地化对象。没有该数组的旧组合包保持原安装流程。插件管理器读取 profile 中最后一条匹配的 patch 覆盖项作为期望状态，一次写入全部选中的行并重新加载。更新失败时恢复 profile manifest 和 patch，再重新加载。CLI 使用声明的默认值；Web 安装器在下载完成后、启用组合包前询问选择。详情页在组合包关闭时仍可预设选择；原有行列表继续显示运行状态与错误。

`dsh.bundle.examples` 可声明最多六个 `{ id, prompt }` 示例；ID 必须唯一，提示文本应本地化。点击示例会打开新会话并填入输入框，不会自动发送。

功能选择属于 profile，而 `$DSH_HOME/AGENTS.md` 与 `$DSH_HOME/skills` 属于 Home。任一活动 profile 都可能让共用 Home 的其他 profile 读到内容。因此不能把提示词或 Skill 开关描述为严格的 profile 隔离。

## Host 执行与 Client UI

### 统一目录与实时功能配置

示例包位于 `custom-plugins/docs/demo`，正式包位于 `custom-plugins/workspace/<name>`。包根保留导出的 Host、Client、Skill 与执行入口，`src/host/` 保存自有运行实现，`src/client/` 保存页面源码，`src/vendor/<source>/` 保存有来源记录的协议实现。`skills/` 只放说明和参考资料；根目录 `cli/` 放 DSH 托管的任务适配器，`scripts/` 放构建、校验脚本。自有文件使用领域前缀和 kebab-case。生成的 `client.js` 由包内构建脚本更新，不手工修改。根入口与 CLI 适配器不能成为独立应用 bin。

组合包可另外声明 `dsh.bundle.featureConfig: "./config.json"`。模板包含 `version: 1` 和完整布尔值 `features` 表，键对应功能 ID；首次使用创建 `<profile>/.plugins/<package>/config.json` 并迁移明确的旧行选择。以后页面、单行开关和手动编辑都使用同一文件，不再写入第二份 profile patch 功能选择。启动时把 JSON 投影到 Cordis 行；HMR 监听文件并在所选 bundle 改变时调整监听范围，没有 HMR 则重启生效。JSON 覆盖旧 profile 行选择，Home 和启动 overlay 仍有更高优先级。非法文件不改写，页面保存后运行失败恢复原文件与运行状态；升级不覆盖已存在的选择。新增、删除或改名功能须同步模板并提供明确版本迁移。未声明 featureConfig 的旧 bundle 保持 patch 配置行为。

### 三处共用页面入口

`settings.section` 注册设置侧栏与页面；`sidebar.panellist` 的 `id` 与 `main` 的 `key` 使用同一稳定标识，提供首页全局面板；`conversation.view` 注册会话 Tab，同时在 `uiConversation.views` 注册对应 target builder。每个入口独立注册和撤销，全部复用一个操作台与 profile 状态源，不读取编译后的 CSS 类名。入口移除时，当前导航回退到可用页面。Client 通过 Remote 调 Host，文案由 locale 持有，开关使用共享 Switch 与主题变量。

AFP 页面任务属于 profile；Agent 任务属于会话。关闭页面不取消任务，停用执行行或组合包须取消并等待任务释放资源。页面写入展示精确目标与增删数量，再提交有期限的一次性确认凭据；Agent 保留 DSH 会话确认流程。凭据不能保存到报告或会话，非幂等写入不能自动重试。目录、配置与写入细节见 [AFP](../workspace/dsh-plugin-afp/README.zh.md)。

Host 代码负责 Node API、文件、子进程、工具及服务调用。执行行可以通过 `pluginManager.registerAction(packageName, id, run)` 注册 Host 操作，并用 `ctx.effect` 管理 disposer。包内脚本只由该操作调用，不是应用入口。Agent 工具与 Client 按钮调用同一个操作。`pluginManager.invokeAction` 通过现有 Remote 暴露实时注册的操作；行卸载后调用会被拒绝，返回文本也受大小限制。不可信输入应在 Host 操作中验证，取消信号应传给子进程。

Client 代码由包的 `./client` 模块提供。包的 `dsh.client` 声明平台与 Client 依赖。用 `ctx.slots.inject` 注册 UI，使它跟随槽位可用性，并在插件卸载时撤销。`plugins.bundle.config` 按 npm 包名绑定组合包自身详情页；`plugins.detail.section` 为其他插件的组合包、行或官方插件详情添加区块。`settings.section` 添加设置侧栏项与功能页；`plugins.row.config` 属于单个行，`plugins.item` 属于官方卡片。注册细节和其他槽位见[插件管理器](../../packages/client/ui-plugin-manager/README.zh.md)与[设置](../../packages/client/ui-settings/README.zh.md)约定。所有可见文案都应本地化。Host 操作须经 Remote 调用；浏览器按钮不能直接执行本地文件。

组合包关闭后，其 Client 入口与 Host 根行消失，设置导航与包自己提供的详情内容随之消失。管理器的通用已安装卡片、功能选择和示例提示仍可见。demo 在 `settings.section` 提供脚本执行与永久移除，留空 `plugins.bundle.config`，避免在组合包详情页重复状态信息。

## 全局内容归属

demo 向 `AGENTS.md` 添加独有标记段落，并管理一个命名 Skill 目录。段落外文本及其他 Skill 目录不受影响。每个活动提示词或 Skill 行在 `$DSH_HOME/.managed-plugins/<package>/state.json` 中记录进程与 profile 持有关系。最后一个有效持有者退出时，内容移到普通扫描路径外的私有 `inactive/` 目录。再次启用优先恢复该副本，其次使用包内默认内容。提示词和 Skill 可以分别停用，也可以分别永久移除停用副本。仍有活动持有者时拒绝移除。管理操作会核对旧进程 ID，收回异常退出留下的内容；标记损坏、名称冲突或停用副本冲突时拒绝覆盖用户文件。

组合包开关保留 profile 选择和停用副本；重新打开时只恢复已选择功能。关闭组合包不能抹去会话已有历史；应在新会话验证模型不再接收相关内容。升级包时应保持标记和归属路径，或提供显式迁移。不要用快照覆盖用户的整份 `AGENTS.md`。

## 构建、安装与恢复

分发前运行 demo 测试、`npm pack --dry-run` 和仓库的插件管理器聚焦测试。核对 tarball 包含 patch 引用的全部模块及 Client 入口。用 `dsh plugin --profile <name> add file:<absolute-path>` 安装本地目录或 tarball；发布后用 `dsh plugin --profile <name> add <package>@<version>`，或在**插件 → 添加插件**输入包标识。安装器从 manifest 显示本地化名称、描述、图标和功能选择。无需全局 npm 安装。没有热重载的 profile 或替换了 JavaScript 的 profile 可能需要重启。

启用失败时，检查行错误和报错的 Home 路径。修复损坏标记，或给冲突的用户 Skill 改名，再重试。若保留对插件活动内容的修改，停用时这些修改会进入下次使用的停用副本。异常退出留下持有记录时，下次内容管理操作会核对并处理。若用户以后可能需要内容，卸载 npm 包时应保留 `inactive/`；所有 profile 停止使用后，才通过显式永久移除操作删除它。

## Dev Note

无。

功能列表中的 `description` 是简短摘要，`details` 是在列表内展开的完整介绍，均需提供英文回退。功能按类型直接分组，每组默认显示四项，其余由“查看更多”展开；仅组件列表保留折叠。需要配置的功能注册 `<包名>#<rowId>` 对应的 `plugins.row.config`，在开关旁获得编辑入口，页面用 `view: page` 在弹窗中显示该表单。凭据值只写入 DSH 凭据服务，部署配置通过 `configEditor.edit` 校验、锁定并保存到 profile patch；功能 JSON 仅存开关。
