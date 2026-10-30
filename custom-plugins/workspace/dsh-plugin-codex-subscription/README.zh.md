---
description: "为 AutoFlow 提供 Codex 订阅授权、生图工具和本地 HTTP 服务。"
kind: "package-bundle"
---
# dsh-plugin-codex-subscription

[English](README.md) | 中文

## 概述

使用 ChatGPT 订阅账号进行 AutoFlow 模型调用、生图和本地 OpenAI 兼容调用。原生图片工具在会话中显示生成卡片与图库，外部客户端可以使用 HTTP MCP 服务。授权由已有的已认证调用方发起，账号和登录交互由模型设置负责；本包不新增独立设置页面。

## 目录

- [使用本包](#use)
- [管理接口](#management)
- [配置](#configuration)
- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制](#limitations)

<a id="use"></a>
## 使用本包

文本模型目录条目可设置 `nativeWebSearch` 覆盖值。发现阶段优先读取 Codex 的 `supports_search_tool` 元数据，再匹配已知模型规则；用户显式选择优先。账号能力分组包含搜索支持，因此开启搜索的路由会排除明确不支持它的账号。原生搜索持有选中账号的租约直至完成，复用 Codex 鉴权，并向现有网页搜索工具返回结构化来源。

AutoFlow 将本包作为可选安装依赖分发，各默认 profile 均不启用。通过现有插件管理启用，或将包名加入 profile 的 bundles。插入的条目是 `codex-subscription` 和可独立开关的 `codex-subscription-tools`。停用会停止监听和工作，保留凭据与图片。

已安装插件分区通过与 AFP 相同的更新器提供独立 GitHub 更新。检查使用 bundle 声明的稳定来源；自动安装需明确开启，重启后应用更新并保留账号数据与配置。来源、资产和验证范围见[发布指南](release/README.zh.md)。模型页面仍属于 AutoFlow 应用。

插件图标跟随应用当前解析后的主题：亮色模式保留原来的 OpenAI 标志，暗色模式使用生成的白色透明标志；系统模式随操作系统偏好切换。

仅在生图调用发起后显示图片卡片，位于实时思考与工具过程下方，详情折叠后仍保留在正文中。卡片出现不会使运行中的过程变为已完成；思考内容仅在模型实际返回后显示。所有工作详情模式的过程摘要均合并为图片图标和一条加载文案，原始思考与工具记录保留在可展开详情中。其中的图片生成请求可打开真实调用详情，不再重复显示生成状态。任务进行时，六条本地化提示每 10–14 秒轮换并轻微淡入淡出；按任务标识和创建时间保持切换会话后的当前文案。后台标签页暂停计时，减少动态效果时关闭淡入淡出，结束或连接状态使用固定文案。常规结果查询只更新原任务，不重复显示卡片。已确认的实时任务显示移动但不脉冲的点阵与预估百分比，任务成功前不会显示完成。重新打开历史图片时只显示图片加载动画，不显示生成用时或百分比。后续已记录结果和后台确认的结束状态优先于旧的进行中快照。点击已保存图片可打开当前 Session 的图库与缩略图列表。部分完成或结果待确认时仍保留已保存图片。离开页面不会取消已接收任务，也不会重复付费请求；图片读取重试只重新加载已保存内容。

模型 provider 为 `autoflow-codex`，发布 `options.catalog` 中明确选择的文字模型；能力和可用账号仍以账号发现结果为准。生图模型使用图片 API。已安装原生目录仅为已知 ID 补充服务端省略的字段。本包不注册供应商页面或登录按钮。

本地中转默认关闭，地址为 `127.0.0.1:3426`。即使在 loopback 上也需要可独立撤销的网关密钥。`gateway-create` 仅在创建时返回密钥；账号 OAuth token 不进入管理响应。

| 路由 | 行为 |
|---|---|
| `GET /v1/models` | 已选择且当前可路由的文字模型 |
| `POST /v1/responses` | 原始 Responses SSE 或最终 JSON |
| `POST /v1/chat/completions` | 文本和图片输入、函数工具及流式响应 |
| `POST /v1/images/generations` | 生成图片 |
| `POST /v1/images/edits` | JSON／multipart 参考图及可选蒙版 |
| `POST /mcp/image` | Streamable HTTP 的 `generate_image`／`generation_result` |

外部客户端使用 `Authorization: Bearer <gateway-key>`。图片结果可包含内联原图或限定任务的短时签名下载地址。服务不接受任意服务器本地文件路径。

MCP 同时接受 `/mcp/magpie/image`、Magpie 的 `reference_images` 和 `generation_result({id})`，并保留 `referenceImages`／`task_id` 写法。等待及文件元数据使用 `usemagpie.ai/pending` 和 `usemagpie.ai/files` 供兼容消费方读取。超过内联预算的图片保留签名下载地址。图片输入支持尺寸比例及 `outputFormat`（HTTP／MCP 使用 `output_format`）。

<a id="management"></a>
## 管理接口

已认证 owner 可向 `POST /api/codex-subscription/manage` 提交 `{ "operation": "…", "args": { … } }`。Host 消费方也可通过现有插件管理调用 `dsh-plugin-codex-subscription` 的 `manage` action。管理接口与使用网关密钥的推理及 MCP 接口分开。

| 操作 | 结果 |
|---|---|
| `login-start`、`login-status`、`login-complete`、`login-cancel` | 浏览器授权地址、安全状态、回调提交与取消 |
| `account-list`、`account-update`、`account-remove`、`model-list` | 安全账号信息、带 revision 的修改及模型发现 |
| `account-status`、`account-quota`、`account-refresh` | 完整账号状态、last-good 额度或显式刷新额度及模型 |
| `model-routes` | 完整能力组、稳定 ID、上游模型 ID 及可用账号键 |
| `model-catalog`、`model-catalog-save` | 明确选择的文字／生图模型及发现候选；带 revision 的保存 |
| `configure`、`snapshot` | 带 revision 的配置修改及有界状态 |
| `protocol-status` | 安全的 WebSocket 计数、降级记忆及版本协商来源 |
| `gateway-create`、`gateway-revoke`、`relay-test` | 网关密钥更换／撤销及本地连接测试 |
| `image-submit`、`image-result`、`image-cancel`、`history-prune` | 持久任务句柄、结果与显式历史清理 |
| `image-session-view`，参数 `{ sessionId }` | 当前 Session 的任务状态与图片标识，不含账号信息或提示词 |

登录时调用 `login-start`，由调用方在用户浏览器打开返回的 `authorizationUrl`，再查询 `login-status`。自动回调与手动 `login-complete` 共用 PKCE／state 校验，支持回调端口 1455 和 1457。插件不提交密码，也不会取消其他应用的登录监听。

令牌兑换和凭据保存完成后，回调才返回自动关闭的成功 HTML；浏览器拒绝脚本关闭时保留手动关闭提示。登录不添加模型或改变默认模型。`modelCatalog()` 读取明确选择和候选，`catalogModels()` 列出已选择且可路由的文字模型。通过 `model-catalog-save` 保存 `{ revision, entries: [{ kind: "text" | "image", id, name }], defaultImageModel? }`。文字 ID 必须已发现或已配置；生图 ID 原样传给上游，不据此推断权限。只有明确传入 `defaultImageModel` 才修改默认生图模型。已准备请求保留其能力。

账号身份组合用户与工作区。同一 Team 的不同成员分别保存；重新登录同一身份保留账号键、控制项和名称，包括任务或重放引用的旧账号键。信息包含用户／邮箱、工作区、token 到期时间（`tokenExpiresAt`，兼容别名为 `expiresAt`）、可选的未来订阅到期时间（`subscriptionUntil`）、套餐来源、授权状态、分操作冷却及发现时间。实时额度套餐优先于 token 声明，缺失额度保持未知。

Host 插件注入 `codexSubscription` 后，可调用 `accounts.getAccountStatus(accountKey)`、`accounts.getAccountQuota(accountKey)`、`accounts.refreshAccount(accountKey, signal)`、`accounts.modelRoutes()`，以及原有登录、账号修改、模型发现和图片方法。状态／额度默认本地读取；传入 `{ fresh: true, signal }` 会显式刷新额度及模型，绕过 TTL 并合并并发刷新。管理 action 接收 `{ accountKey, fresh? }`，其中 `account-refresh` 只接收 `{ accountKey }`。`requestResponses(body, signal)` 的响应体必须消费或取消；`protocolStatus()` 读取本地传输／版本状态。

`auth.state` 为 `ready`、`refreshing`、`refresh-required` 或 `needs-login`。终止型刷新拒绝按凭据代次持久保存，直到成功刷新或重新授权；网络／5xx 失败仍可重试，旧拒绝不能撤销新凭据。额度包含 credits、allowed／held 状态、消费上限、窗口时长／重置及可用 reset 数量和可选到期时间。`status`、`freshness`、`lastSuccessfulAt`、`attemptedAt` 和安全 `errorCode` 区分 last-good 值与读取失败。reset 明细只读，插件不会自动消耗 reset。

Plus、Pro 和 Business 共用 OAuth 和动态发现，套餐名不代表固定额度或生图权限。可空字段保留有效窗口。Business 工作区超额使用必须明确尚有组织额度，且没有消费／所有者限制；Team 与 `self_serve_business_prolite` 保留 reserve 规则。`credits.usable` 对齐 Magpie 的积分续用提示：不限额，或报告有积分且余额为正／未知。明确的非正余额取消提示；上游 held 状态与用户 `allowCredits` 保持独立。HTTP、超时和响应解析失败使用不同 `errorCode` 和可选 HTTP `errorStatus`，不返回原始上游消息。

`account-update` 通过 revision 修改 `allowCredits`，默认值为 `true`，与 Magpie 一致。设为 `false` 时，已知耗尽且未重置的窗口会阻止文本派发，轮询失败、字段缺失和重启均保留保护。额度轮询及 HTTP／WS 实时观察通过 Home credential provider 持久保存，关闭时等待写入完成。上游 held／工作区超额规则也参与文本调度。`Retry-After` 秒数及 HTTP 日期可延长分操作冷却，不缩短已有等待；安全重试／请求信息贯穿原生错误、图片任务存储及本地 HTTP 错误。

共享请求定义由 [management.ts](src/shared/management.ts) 管理。access、refresh 和 ID token 仅保存在 Host credentials；模型可见的原生图片工具不提供账号或网关管理能力。

<a id="configuration"></a>
## 配置

部署设置通过 profile patch 提供。此示例在创建网关密钥前保持中转关闭：

```json
[{"id":"codex-subscription","config":{"options":{"images":{"defaultModel":"gpt-image-2","timeoutMs":300000},"relay":{"enabled":false,"port":3426}}}}]
```

默认值与限制由 [config.ts](src/host/config.ts) 定义。图片任务默认五分钟期限，可配置到一小时；原生工具和 MCP 的快速等待最多二十秒。`options.images.uiPollIntervalMs` 控制浏览器共享任务读取间隔，默认 1000 ms，范围 250–30000 ms。页面释放后会停止读取，不会取消任务。已接收任务保留自己的配置。网关限制请求体、响应、并发及签名地址有效期。

`options.upstream.mode` 默认为 `auto`，设为 `sse` 可强制使用 HTTP。WebSocket 连接超时默认三十秒，不支持的主机及 1009 大小记忆默认十分钟，单消息限制为 16 MiB，队列字节限制为 32 MiB。每个连接保留接收时的配置。`options.models.fallbackMaxTokens` 默认为 8192，用于服务端未声明输出限制的新模型。`options.version` 控制本地元数据发现、默认十分钟的探测间隔及缓存读取上限。

<a id="implementation"></a>
## 实现

<details>
<summary>实现细节</summary>

[plugin.ts](src/host/plugin.ts) 注册账号、模型、发现和已认证管理能力。内部模型调用复用 `PiAiAdapter`，其 SSE 消费方与外部 Responses 共用 [upstream.ts](src/host/upstream.ts)。仅发往固定 Codex Responses 地址的流式 POST 使用 WebSocket，图片 REST 和 OAuth 调用保留 HTTP。[ImageService](src/host/images/service.ts) 为原生工具、MCP 和 Images 路由提供统一持久任务服务。

WebSocket 使用 `responses_websockets=2026-02-06` 握手并发送 `response.create`。turn-state／Lite 请求头进入 `client_metadata`，前导 metadata 和额度事件转换成安全响应头。握手被拒、连接数限制及响应发布前断线会降级为原始 HTTP 请求体。不支持的主机和 1009 消息大小分别记忆；握手的 401、429 或服务端错误不禁用下一次 WS 尝试。发布响应后的流错误不会触发 HTTP 重放。取消及卸载关闭连接、定时器和自有代理 agent，代理路由沿用 Host 启动器的策略。

[models.ts](src/host/models.ts) 消费服务端的上下文、最大上下文、输出预算、输入模态、reasoning 档位／默认值和 service tier。[routes.ts](src/host/accounts/routes.ts) 按完整能力分组：上游模型 ID 选择完整能力最强的组，首先比较上下文；其他组使用 `dsh-cap:…` ID。`model-routes` 还提供每组稳定的 `capabilityId`，该组变为默认组后仍可解析。所有降级候选账号必须支持该组声明的全部能力。prepare 冻结描述符、默认值和账号，新增账号或后来目录不能改变已准备调用。原生与 raw 请求均发送真实上游模型 ID。显式 raw reasoning／tier 请求选择兼容的完整能力组，信息不足的新模型保持不可用。

[version.ts](src/host/version.ts) 从 `clientVersion`、本地 Codex 包元数据、`models_cache.json.client_version` 和已认证网关客户端的 version／User-Agent 提示中选择较新的数字版本。选中版本不会降低，不执行探测到的 CLI，也不读取 `auth.json`。版本变化会刷新目录，共享 fetch 将选中版本应用到模型列表查询、version 请求头及 Codex User-Agent。本地发现可单独关闭，不影响已认证客户端提示。

[codex-request.ts](src/host/codex-request.ts) 统一无状态历史转换、缓存标识、reasoning 和 service tier 规则，保留调用方指令及显式工具选择。配置的版本基线默认为 `0.159.0`。输出前完整的 401／402／403／429 拒绝可逐个尝试符合条件的账号，派发前终止型刷新拒绝也可换号。普通服务端失败、网络结果未知和已有部分输出均不重放。401 可在共享锁内更新被拒的凭据，同时保留原请求失败结果。

任务按 profile 隔离，在恢复至卸载期间持有跨进程写锁。每张原图与规范化预览分别提交。部分成功保留已保存图片并标记 `image-partial-result`；已有附件的中断任务在重启后仍可读取。已发送但未确认结果的任务记录为 `outcome-unknown`，不会自动重复付费请求。账号凭据由 Home 的 credential provider 独立持久保存。

</details>

<a id="model-experience"></a>
## 模型体验

`autoflow-codex` 保留 AutoFlow 已记录的系统指令。`codex_image_generate` 返回持久任务，`codex_image_result` 查询或取消该任务。规范工具结果保留附件引用和状态；只有当前模型支持图片输入时才向模型提供图片内容。

编辑时，`referenceAttachmentIds` 接受当前会话可见的图片 ID 或本会话图片任务返回的 ID；`latest` 选择最近一张可见图片，无可见图片时选择本会话已生成的图片。生成图片的 ID 使用保留的原图。`maskAttachmentId` 按相同授权和字节限制读取遮罩。未知及其他会话的 ID 在派发前拒绝；外部 HTTP／MCP 输入不会因此获得会话附件读取能力。规范错误结果保留安全的重试时间与请求 ID。

生图仅使用已开启 `allowCredits` 的账号，因为图片后端没有已验证的“仅用订阅”消费控制。关闭积分后，该账号不参与生图派发并返回 `IMAGE_CREDITS_DISABLED`；文字请求保留按窗口判断的规则。文字额度百分比不代表生图权益，开启积分也不保证拥有生图权限。

<a id="limitations"></a>
## 已知限制

Codex 订阅授权与 OpenAI Platform API key 分开，模型及图片访问以账号和工作区权益为准，Codex 专用接口可能变化。模型目录仍保存在实例内，重启后首次发现失败会返回空目录。已知额度持久保存，从未成功观察额度的账号仍为未知。旧版本写入可能丢弃新增可选健康／额度字段，避免新旧版本同时操作同一 Home。身份修复无法恢复此前已被覆盖的凭据。

远程图片下载当前要求公有 IPv4 目的地址及标准 HTTP(S) 端口，本地路径、私网、仅 IPv6 的目的地址和内嵌凭据 URL 会被拒绝。文本输出开始后不会拼接另一个账号的输出；有状态 Responses continuation 及未支持的 Chat 参数会明确拒绝。

本包不提供独立可执行程序或 stdio server。浏览器模块提供图片工具卡片与 Session 图库；OAuth 仍使用 OpenAI 的外部登录页面，模型页面的登录展示由应用的模型设置消费方负责。

本包实现 Codex OAuth。尚未实现 Magpie 独立的 `chatgpt-api` Sign in with ChatGPT provider、自动导入其他应用凭据、原生 Codex 辅助路由（`alpha/search`、compact／Lite）或完整多厂商路由。没有包／缓存元数据的独立 CLI 二进制需要显式 `clientVersion` 基线或已认证客户端提示。远程图片下载使用地址固定的下载器，即使 API fetch 使用代理，也可能需要直连出网。

## 开发

```sh
pnpm --filter dsh-plugin-codex-subscription run check
pnpm --filter dsh-plugin-codex-subscription test
pnpm --filter dsh-plugin-codex-subscription run build
```

### 开发备注

协议 fixture、生命周期测试与源码构建不能证明某个账号的真实订阅或生图权益。完整授权、推理和生图验证需要用户完成登录，并使用该账号的可用额度。
