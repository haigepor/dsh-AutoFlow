---
description: "通过 ctx.skillManagement 管理技能副本。Web bundle 将服务挂载在原生注册表旁。清单保留无效和被覆盖的文件；启停策略排除停用副本，不扩大 frontmatter 声明的调用权限。目录以原生提供方配置为准，外部来源只读，项目写入要求已登记的本地工作区。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-manager

[English](README.md) | 中文

## 概述

通过 ctx.skillManagement 管理技能副本。Web bundle 将服务挂载在原生注册表旁。清单保留无效和被覆盖的文件；启停策略排除停用副本，不扩大 frontmatter 声明的调用权限。目录以原生提供方配置为准，外部来源只读，项目写入要求已登记的本地工作区。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

写入使用明确的目标和版本检查。仓库更新要求精确匹配的预览标识，并保留上一份文件。备份存放在当前 profile 的 skills-manager 目录中，直到显式删除。maxBytes、maxFiles 和 requestTimeoutMs 限制上传与下载。来源和分类信息与技能 Markdown 分开保存。

详情包含目录清单，文件与目录的条目总数受 maxFiles 限制。列举只读取名称，不执行脚本或跟随符号链接；无法读取或被截断的子目录明确标记为不完整。扁平 Markdown 技能仅列出指令文件，纯运行时技能没有本地文件条目。

本包在 assets 中提供只读且仅供用户调用的 `skill-creator`，通过原生注册表和显式 `/skill-creator` 调用发现，不增加面向模型的目录条目。该技能引导需求确认、原生 Markdown 编写、资源组织及实际验证。设置页创建操作只准备草稿，不发送模型请求。

<a id="model-experience"></a>
## 模型体验

无，因为服务不登记面向模型的工具或目录，只管理存储的技能副本与注册表状态。

#### KV Cache effect

不改变模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 联网发现要求外部服务可用。
- 只管理本机可读的来源，不把远程工作区路径映射为宿主目录。
- 备份不会自动清理。

<a id="dev-note"></a>
### 开发备注

无。
