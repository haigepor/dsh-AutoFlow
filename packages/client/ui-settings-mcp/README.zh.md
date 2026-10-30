---
description: "在设置中管理 profile 的 MCP 服务并查看实时连接状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-mcp

[English](README.md) | 中文

## 概述

设置 → MCP 服务列出已配置的本地程序和远程服务，显示启停、连接状态及已发现工具。随附 Web 组合包含此页面；Desktop 使用同一组合。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

添加 MCP 打开 stdio 或 Streamable HTTP 编辑器。保存时校验配置，将条目写入当前 profile 补丁，再协调插件状态。已停用服务也可以编辑。环境变量和请求头的值不会返回页面：未改动的已保存项保留原值，输入新值会替换原值，移除一项会删除该键。未改动的原始表达式仍以表达式保存。

启停开关控制配置的插件。连接状态单独展示：已保存且已启用的服务仍可能正在连接或连接失败。重启服务释放当前连接，并等待替换连接。已有会话在后续模型执行步骤中读取调用方可见的工具注册，保留会话身份和历史。

重启并应用通过所属启动器显式请求应用重启。历史会话保持持久化；正在执行的任务会停止，不会自动重跑。不支持重启的启动器会明确拒绝操作。

<a id="understand-the-implementation"></a>
## 理解实现

Host 的 [MCP 管理器](../../mcp/mcp-manager/README.zh.md)拥有经校验的 `mcpSettings` Remote 操作。ConfigEditor 拥有 profile 原子写入和回滚；PluginManager 拥有持久化启停与启动器重启。可选的 MCP 连接注册表按 Fiber 身份提供连接状态。客户端资源提供方发布隐藏敏感值的列表和详情快照；声明式 store 将操作反馈与应用浮层共享。详情修订号用于拒绝过期保存。

MCP 页不显示共享的配置文件页脚。介绍区将已有鲸鱼女仆形象放在配置说明和无障碍提示控件旁。生成提示词保存在透明 WebP 素材旁；图片只作装饰，不进入无障碍树。

提示与模型页共用点击气泡和菜单材质。连接方式使用共享 Menu，高级字段使用 AnimatedCollapse。列表和编辑器加载占位保留各自尺寸，并与模型页统一使用 7% 主文字色底色、共享小圆角和轻柔的 1.8 秒扫光；减少动态效果模式下保留静态占位。

JSON 操作在共享的 Shiki 高亮 CodeEditor 中打开当前隐藏敏感值的 `mcpServers` 文档。导入按名称合并 stdio 或 HTTP 声明；未列出的服务继续保留，`disabled` 控制启停，null 敏感值保留已有键。编辑保留打开时的修订号和未改动表达式。每个服务沿用既有管理操作；批量操作失败时停止，并报告部分进度，供用户显式重新读取与核对。

JSON 导入在生成编辑前拒绝 HTTP 地址内嵌的用户名或密码。认证值应存放在受保护请求头中，后续读取仍隐藏敏感值。

<a id="further-exploration"></a>
## 进一步探索

- [MCP](../../../docs/subsystems/mcp.zh.md) — 传输、工具作用域、资源和指令。
- [MCP 客户端](../../mcp/mcp-client/README.zh.md) — 服务器配置与连接行为。
- [ConfigEditor](../../boot/config-editor/README.zh.md) — profile 持久化和协调。

<a id="model-experience"></a>
## 模型体验

### 配置变更

#### 模型看到什么

`settings.section` 页面自身不贡献模型输入。受管理服务器通过 MCP 客户端贡献工具和指令，仍受调用方作用域和限制控制。

#### Token 影响

页面不增加 token；已启用服务器的工具和指令决定其请求成本。

#### KV Cache 影响

工具与提示词变化沿用 agent-loop 既有请求历史；页面自身不增加模型输入。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 只有可寻址的 profile 条目可以编辑；ACP 声明仍由所属会话请求管理。
- 服务器程序的安装和提供方认证设置不由此页面负责。
- 已经发出的模型请求无法追溯更新工具 schema。

<a id="dev-note"></a>
### 开发备注

插件激活本身不代表连接就绪：应使用工具发现后的连接快照。配置恢复不能套用仅允许升级后重启的准入规则。
