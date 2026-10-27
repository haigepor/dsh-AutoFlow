---
description: "管理 profile 中的 MCP 条目，并提供隐藏敏感值的连接状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

[English](README.md) | 中文

## 概述

`mcpSettings` Host 服务为 [MCP 设置页](../../client/ui-settings-mcp/README.zh.md)管理 profile 所属 MCP 条目。它提供隐藏敏感值的列表和详情、经校验的新增与编辑、持久化启停和连接重启。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

随附 Web 组合将本服务与 MCP 连接注册表及配置所有者一同挂载。调用方在编辑前读取详情修订号。隐藏的环境变量和请求头值以 null 表示保留，提供字面值则替换对应键。编辑停用条目不会启动服务器。连接状态与持久化成功独立展示。

HTTP 地址在保存前拒绝内嵌用户名或密码，认证信息应存放在受保护请求头中。无效地址诊断只返回结构化失败码。

<a id="understand-the-implementation"></a>
## 理解实现

ConfigEditor 串行执行 profile 原子写入，通过所属 MCP schema 校验停用状态的编辑，拒绝被更高层覆盖的无效更改，并在协调失败时恢复配置。PluginManager 提供持久化启停。连接重启等待所属 Fiber 卸载及替换实例激活，不替换会话。列表和详情响应不包含凭据值；`mcp-settings/changed` 使对应客户端资源重新读取。

<a id="model-experience"></a>
## 模型体验

### 受管理服务器的贡献

#### 模型看到什么

`mcpSettings` 管理器不增加模型输入。受管理服务器通过 [MCP 客户端](../mcp-client/README.zh.md)贡献能力，调用方作用域与工具限制仍然有效。

#### Token 影响

管理器不增加 token；每个已启用服务器决定其工具和指令。

#### KV Cache 影响

缓存影响由 agent-loop 既有工具和提示词变更记录决定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 只有当前 profile 中可寻址的条目可以编辑；ACP 声明仍由请求拥有。
- 本服务不安装服务器可执行程序。
- 已经发出的模型请求保留其原始工具 schema。

<a id="dev-note"></a>
### 开发备注

连接注册表对普通 MCP 客户端是可选能力，对本管理服务是必需能力。公开配置值取自 MCP 客户端 schema；管理器保留编辑器没有改动的原始字段。[MCP 子系统](../../../docs/subsystems/mcp.zh.md)维护连接与资源语义。
