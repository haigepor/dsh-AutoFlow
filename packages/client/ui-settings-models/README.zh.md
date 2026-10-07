---
description: "dsh Web 客户端的模型设置与产品引导插件：提供商行、API 密钥管理、模型列表与 DeepSeek 首次运行弹窗。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-models

[English](README.md) | 中文

桌面端产品事件使用可选的[产品埋点服务](../product-analytics/README.zh.md)，不包含普通 Web 交互。

## 概述

`dsh-client-ui-settings-models` 是 dsh Web 客户端的 Models 设置页面：用户可以配置 API 密钥（以只写方式存入 profile 的凭据引用之下）、编辑每个提供商的模型列表，并手工声明自定义 pi-ai 路由；页面采用左侧提供商列表与右侧配置区，一次只展示一张编辑表单。该页面把提供商目录、设置文档与凭据描述合并为一个共享快照，因此行的状态在三个方面始终一致。它还会带首次运行的用户走两个有序弹窗——版本化预览版说明，以及按条件显示的官方 DeepSeek 凭据步骤。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

保存凭据或自定义提供方时保留已选模型。用户可在 composer 中选择可用模型。

提供方列表中 DeepSeek 账号排第一，DeepSeek 排第二；第三方提供方保留目录中的相对顺序。

从设置导航打开 Models 页面，可在左侧选择已配置的提供商，在右侧编辑配置或添加目录与自定义 API。各编辑器保留草稿，并按 revision 检查保存；窄窗口将侧栏移到编辑器上方。模型表格主行直接编辑标识、显示名称和默认思考强度。默认强度菜单显示低、中、高、最高，不支持的档位会禁用，并提供展开容量、输入类型和支持档位配置的快捷入口。明确新增的适配器扩展档位也可选作默认值。菜单项间距为 4px，沿用亮暗主题变量。

提供商列表项沿用主页侧边栏的悬浮高亮效果，选中项保留同样的浅色背景。

满高工作区采用 240px 提供商栏、16px 双栏间距，以及带细边框和轻阴影的编辑器。仅表单内容滚动，取消与保存固定在底部。首次加载保留页面标题，显示匹配布局的骨架并标记 `aria-busy`；刷新及刷新失败时保留编辑草稿，失败后提供重试。固定操作栏仅用于模型设置页，引导与添加提供商表单保持原布局。 提供商标题旁的按钮可将侧栏收窄到 56px，再次展开不会丢失编辑草稿。收起时保留提供商首字标识、凭据状态点与添加图标，悬浮显示名称；宽度和文字过渡沿用共用侧边栏时序。

存在已存储目录错误的提供商仍显示诊断以及编辑、删除入口。添加操作只面向已注册的 settings 命名空间，因此不可用的命名空间不会留下无法打开编辑器的按钮。保存被拒绝时，编辑器保持打开并展示 Host 诊断。

Host 配置 `credentialOnboarding` 默认为 `true`。Electron preload 标记会抑制自动凭证引导和 Web 欢迎须知；模型设置页与显式 API Key 编辑仍然可用。[账号插件](../ui-settings-account/README.zh.md#desktop-onboarding)负责 Desktop 引导。其他原生壳可以通过 `credentialOnboarding: false` 仅禁用凭证步骤。Host 通过 `webserver/index-inject` 发布这个公开的布尔值，Client 在注册弹窗前校验它。它是页面初始化数据，不是持久化的完成标记。

### API 密钥

API 密钥输入框初始为空，并通过 `autocomplete="new-password"` 请求浏览器不要自动填入已保存的登录密码。

编辑卡片上的主字段是单独一个 **API 密钥**输入框——页面从不询问环境变量名。键入的密钥经 `credentials.set` 以**只写**方式存入 profile 的引用之下，profile 没有引用时便派生 `<ROUTE>_API_KEY`，pi-ai profile 会把这次派生记录为 `apiKeyEnv`，因此 `cordis.patch.yml` 从不携带密钥值。为新的 pi-ai 提供商留空密钥会保存一个不带引用的 profile，从而保留提供商原生认证（例如 Bedrock 凭据链或 Vertex ADC）。只有确认引用的凭据已配置时，提供商列表项才会以绿色实心点标示 API 密钥状态；只有确认具名引用缺失时，才会以红色实心点标示。「应用」成功后显示共享的主题感知成功通知，且绝不回显任何机密内容。连续保存会重新开始通知的显示周期，通知随后自动消失。

### 编辑提供商

模型标识、容量和默认思考强度控件采用紧凑的 32px 高度。展开区将容量输入与输入类型放在带标题的思考强度选项之前，亮暗主题均使用较轻的选中边框。

「自定义设置」折叠区提供端点、适配器模型目录，以及自定义 pi-ai 路由的显示名称和 API 协议。Provider ID 保持固定，profile headers 仍属于部署配置。能力编辑区始终显示关闭、低、中、高、最高；用户可切换适配器 schema 支持的档位，不支持的标准档位会禁用。「新增档位」菜单提供 schema 允许的扩展标识。新建自定义 pi-ai 模型时默认启用低、中、高、最高，并以对应标识作为 wire 值、以高为默认；已有模型保持不变。模型尚无覆盖时显示内置目录能力；点击档位会创建明确的模型级子集，并在可用时保留继承的 wire 值。默认强度菜单不提供跟随供应商或关闭选项；支持高档时初始值为高。高级配置可编辑映射，且不按模型名称推断协议。移除已选模型默认档位后，必须重新选择默认值才能保存。打开编辑器不会重写配置。

`llm-deepseek` 的 DeepSeek 卡片编辑端点、凭据和模型目录。它使用 Messages，默认端点占位符为 `https://api.deepseek.com/anthropic`。

展开**自定义设置 → 模型选项**编辑模型。两个提供商家族共用带模型 ID、显示名称和操作列的可编辑表格布局：上下文窗口与最大输出 token 数分为两列，**输入类型**独占下一行，提供**文本**和**图片**复选框。未声明输入类型的模型行优先显示已安装模型的输入类型，其次是提供商默认值，最后回退为文本。已知 pi-ai 提供商会加载已安装目录，不向端点发送请求；打开模型行不会写入覆盖值。显式输入选择具有优先权，包括为视觉模型设置的仅文本覆盖。修改复选框会保存所选类型，且至少保留一种。DeepSeek 写入 `inputModalities`，pi-ai 写入 `input`。DeepSeek 取消勾选图片时，还会移除 `imagePixelBudget` 和 `imageMaxBytes`，因为适配器在没有图片输入时拒绝这些限制。在 `cordis.patch.yml` 中清除输入字段可恢复适配器继承；**恢复默认模型**会重置整个模型目录覆盖。仅声明上游模型实际能够处理的输入类型。

模型表格显示行序号。拖动手柄可调整顺序，也可以聚焦手柄后按上下方向键；保存时沿用调整后的数组顺序。排序时，每个模型的展开选项和未完成的容量输入会跟随该模型。自定义设置与模型选项使用可反向连续过渡的 250ms 高度、透明度动画和旋转箭头；收起内容保持挂载但设为 inert，减少动态效果时立即切换。两个目录共用线性的目录与模型节点图标。凭据状态点位于固定在最右的自定义标签之前；悬浮或键盘聚焦时，删除图标覆盖标签，名称和状态点不移动。触屏设备持续显示删除图标。删除其他提供商后保留当前编辑器与草稿；只读或写入进行中时禁用操作。

### 新增与删除提供商

DeepSeek 删除图标打开**清除配置**确认框，并保留提供商入口。操作按确认时的设置修订号清除可写用户层字段，再重新检查凭据状态，清除未被共享的可写、本页管理凭据。基础配置、环境凭据、只读凭据及共享引用保留。无可清除内容时禁用按钮并说明原因。冲突或分阶段失败会在确认框保留诊断，重试仅继续未完成阶段，不重复已完成的设置写入。取消确认保留编辑草稿。

**添加模型提供商**位于提供商列表底部：只要任一带编辑器的设置 namespace 已挂载就会出现，下述两种方式任一可继续时才可点击。卡片打开后顶部是分段式的方式切换，所选方式的补充说明由信息按钮展开：**第三方模型提供商**承载休眠目录提供商菜单与提供商编辑器——裸挂载的 `llm-pi-ai` 在任何路由存在之前就能提供其完整的已安装 catalog；**自定义模型 API**承载为 pi-ai 不提供的路由（中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口）准备的创建表单。某种方式只在其 namespace 已挂载时提供；只剩一种方式时卡片以该方式为标题直接显示表单；namespace 已无可采用的提供商或没有可声明的协议时，对应方式会被禁用并把原因作为悬停提示。面板在其方式首次显示时挂载，之后在卡片打开且该方式仍被提供期间保持挂载但隐藏，因此切换方式不会丢掉任何一边的草稿；任一面板有写入或端点探测进行中时滑块锁定，因为此时切换会让结果落到看不见的面板上。每个 tab 通过 id 控制其面板，关闭任一面板都会忘记目录草稿的目标。自定义表单自动生成以 `custom-` 开头的随机 **Provider ID**，避开当前目录中的已有标识，并允许手动修改。编辑草稿与切换方式时保留该值，重新打开新建表单时生成新的值；端点、协议与至少一个可唯一识别的模型仍须填写。协议选择框以产品名称显示各协议——OpenAI Chat Completions、OpenAI Responses、Anthropic Messages——存储的值仍是 schema 标识符；适配器新增而本页尚未命名的协议直接显示其标识符。端点占位示例随所选协议变化：OpenAI Chat Completions 与 Responses 显示 `https://gateway.example/v1`，Anthropic Messages 显示 `https://gateway.example`，因为其 SDK 会追加 `/v1/messages`。切换协议会保留已输入的地址。端点必须是可解析的 HTTP 或 HTTPS URL；localhost、IPv4 与 IPv6 字面地址以及自定义端口仍然有效。语法错误会在字段处阻止询问与创建，请求失败则继续作为独立的提供商错误显示。**获取可用模型**通过 `llm/discoverModels` Remote 查询表单显示的端点，因此新增提供商一次即可完成，而非先保存再返回；回复打开的是可搜索选择器而非直接写入，只有点击**添加所选**才会写入。候选项使用等宽字体显示原始模型 id，以区分同名模型。每行保持单行，悬停可查看模型名称，未提供名称时回退到完整 id。勾选与配置仍使用原始模型 id。每个选中候选会在提供商公布相应信息时，把 id、显示名、上下文窗口、最大输出 token 数和已公布的输入类型复制进可编辑行；已经存在的行保留用户调整过的值。搜索会匹配模型 id 与可选显示名称，且不会清除隐藏项的勾选状态。**全选**会加入可见结果，而**取消全选**会清空全部勾选，以免意外采用隐藏结果。只有用户层单独携带某行时，该行才可删除（删除会恢复组合基线），其确认对话框会指名该提供商。

### 首次运行弹窗

版本化声明步骤完成后，DeepSeek 步骤从同一份合并快照投影首次运行就绪状态。用户已经能够到达的**任何**提供商都会直接结束该步骤、不做渲染；只有没有任何提供商的用户才会被询问官方 DeepSeek 密钥。「稍后配置」只完成这次协调器遍历；适配器缺失、路由不活动、合并失败、只读部署或能力不可用时，该步骤不渲染即完成——Models 仍是诊断界面。

### 扩展 slot

本分区为仓库外分发的插件声明两个席位，类型定义在 [`src/client/slot-contract.ts`](src/client/slot-contract.ts) 并从 `./client` 导出。`settings.models.provider-card`（keyed）渲染在当前选中的已保存提供商配置区、其首次运行 setup 形态或「添加提供商」草稿中——以 `entryKey = settingsNs` 分发，owner props 携带该行的 `ConfigurableProviderView`、其 configured 状态与已确认的 api-key 凭据状态，因此以某适配器家族的 namespace 注册一次即可收到该家族当前选中的配置区，含手工声明的路由；手工声明的草稿卡尚无目录行，保存之前不分发。`settings.models.footer`（list）渲染在提供商工作区之后。注册方通过 `ctx.slots.inject` 激活，并以 type-only import 引入本包 `/client` 入口；没有注册方时两个席位均不渲染任何内容。

Models 页面包含 **DeepSeek 账号**（`deepseek-account`，英文为 **DeepSeek Account**）。其编辑器展示共享的 DeepSeek 模型目录，不提供 API Key 或 Base URL 输入框；目录保存到账号路由自己的设置段（默认为 `llm-deepseek-account`），因此账号侧的编辑不会改写 official 路由读取的 `llm-deepseek` 段。账号可用模型目录为空时隐藏账号行，包括登录前和退登后；账号模型恢复可用时重新显示。

-----

页面沿用共用的设置标题与页边距。窄窗口将提供商栏移到有界高度的编辑器上方，操作栏仍在编辑器内保持可见。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

页面只持有脱敏后的描述符，从不持有完整设置分区：因此每次编辑都以 `settings.mutate` 路径操作落到已存分区上——每个改动字段一次 set、每个清除字段一次 unset、删除提供商行则一次 unset。

### 校验

键入的 API 密钥按其自身字段判定：去除首尾空白后必须非空，且每个字符都必须是可打印 ASCII（`[\x21-\x7E]`），这正是 HTTP 头值能够携带的字符集——与 `@deepseek-ai/dsh-llm` 中的 `normalizeApiKey` 互为镜像，此处复刻是因为源平面拆分禁止导入它。与粘贴的 `NAME=value` 环境行一致或包裹在匹配引号内的值，会作为同样的格式失败被拒绝。空 id、重复 id、空显式名称以及不可读、非正数或小数的容量都会在任何写入之前失败。DeepSeek 的 `models` 是一个按值整体替换的数组：编辑器先显示继承的有效行，直到第一次模型编辑把完整数组物化进用户层，重置则取消该覆盖。

### 并发与凭据

每次 settings 写入都携带卡片当前的 `revision`，因此来自另一个标签页或外部 `cordis.patch.yml` 编辑的并发写入会以 `settings/conflict` 被拒绝。settings 提交后，卡片会在存储凭据前采纳返回的脱敏用户子树与 revision，因此失败的凭据阶段只重试该阶段。删除只会在 profile 指名本页派生的 `<ROUTE>_API_KEY` 目标时移除已配置且可写的凭据，然后 unset 该 profile；两个操作都幂等。加载完成后，页面订阅转发的 `settings/document-updated`、`credentials/reference-updated` 与 `llm/adapters-updated` 属主事件，以及本地 `connection/reset`，因此外部编辑无需轮询即可收敛。

### 引导协调器

声明步骤在 `src/client/locales.ts` 中持有精确文案，并在 `src/onboarding-copy.ts` 中持有确认版本；回环时它通过既有 settings API 比较并写入 `ui-settings-general.welcomeNoticeVersion`，且只有显式点击「继续」才会记录当前版本。已确认旧版的用户会再次看到当前说明。非回环浏览器无法使用这个仅限宿主的 namespace，因此确认只保留在进程内，刷新后声明会再次出现。DeepSeek 步骤面向 `llm-deepseek` 中的 `deepseek-official`，在共享引导模态框内以仅凭据模式渲染既有 `ProviderEditor`；`credentials.set` 仍是唯一的机密写入，且不改变任何提供商设置。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖设置底座、本页所合并的 seam 与设计依据。

- [ui-settings](../ui-settings/README.zh.md)——本页所依赖 scope 与 schema 服务所在的领域底座。
- [settings](../../settings/README.zh.md)——持久化用户设置 seam 及其文件提供方。
- [credentials](../../credentials/README.zh.md)——本页写入密钥所经的凭据引用 seam。
- [llm](../../llm/README.zh.md)——本页所配置提供商所在的适配器注册表。
- [Web 配置平面](../../../.agents/notes/archived/architecture/2026-07-30-web-config-plane.md)——手写编辑器的设计依据。

-----

`settings.models.sign-in` 插槽让账号登录在凭证编辑器之前提供选择；没有贡献者时直接显示编辑器。关闭账号选择弹窗会结束整个引导步骤。从账号菜单显式重新打开时，即使已有提供者配置，也会进入同一个编辑器。

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供商请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义编辑器的字段覆盖范围与本页的触达范围；它们是当前包约束，不是设置路线图。

- **卡片上只有 API 密钥与精选折叠字段可编辑**：手写编辑器以 schema 通用字段覆盖换取了 mockup 布局。重试策略、超时、DeepSeek 模型说明及其他进阶字段仍留在 `cordis.patch.yml` 中；编辑器未展示的现有模型字段会予以保留。
- **凭据清理范围刻意保持狭窄**：删除一行时，仅当其引用与页面派生的 `<ROUTE>_API_KEY` 目标完全一致，才会清除已配置且可写的凭据。自定义引用、环境凭据与无法识别的目标会保留，因为该行无法证明自己拥有它们。
- **只有 pi-ai 路由可以手工声明**：自定义模型 API 表单写入 `llm-pi-ai`——唯一一个其 profile 描述整个提供商的 namespace。`llm-deepseek` 路由是组合面的事实，不是本页能创建的东西。
- **目录选择框列出的是路由标识符**：`moonshotai`、`zai` 等 pi-ai catalog id 原样显示，没有产品名、别名或搜索。一个把自定义表单作为置顶项的可搜索选择器可以取代方式切换；前提是目录先携带显示名称。
- **询问覆盖 OpenAI 兼容与 Anthropic Messages 端点**：OpenAI 协议接受标准 `data` 数组或富信息 `models` 对象，Anthropic 则使用原生模型列表路由；其余协议会报告自己无法被询问，其模型需手工填写。
- **未声明的存活路由无处渲染**：未附带可配置提供方声明即注册的路由没有 settings 地址；它在各选择器中仍然可见，但不会出现在本页的行里。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是只贡献 nav entry 的 section 插件，渲染固定空 content column，不发出 Cordis 事件，也不持有跨插件可变关系。
