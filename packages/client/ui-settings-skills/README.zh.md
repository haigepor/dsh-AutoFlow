---
description: "通过设置页的技能卡片、快速预览和完整详情管理全局及项目技能。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-skills

[English](README.md) | 中文

## 概述

打开设置 → Skills技能，可管理全局和项目指令、导入文件或技能包、订阅公开 GitHub 仓库、浏览 skills.sh 和 ClawHub，以及恢复保留的备份。紧凑介绍区与 MCP 使用相同尺寸，并使用其手持书本的同系列插画。卡片与加载占位共用响应式三列网格。点击卡片在一个分栏弹窗中查看完整指令、目录及来源信息；指令按 Markdown 渲染，编辑时显示完整源码。状态与分类筛选始终显示各自的字段名称。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

新建技能打开工作区与模型选择弹窗，继续后创建新对话、保存所选模型，并通过现有对话服务预填可编辑的 `/skill-creator` 草稿，用户补充需求后发送。导入使用共享按钮打开原生文件或目录选择器，展示已选文件，保留明确的写入位置和覆盖选项。

发现页将公共市场搜索与 GitHub 仓库浏览、订阅分开，共用明确的工作区上下文和安装位置。来源目录按本地、内置和外部归属分组，展示完整路径与访问权限，登记变化不移动文件。选择器触发区域填满所属字段，使浮层菜单与按钮按同一宽度定位。技能详情将标识、页签和操作固定在正文滚动区域之外，并限制 Markdown 行宽。

写入使用明确的目标和版本检查。仓库更新要求精确匹配的预览标识，并保留上一份文件。备份存放在当前 profile 的 skills-manager 目录中，直到显式删除。maxBytes、maxFiles 和 requestTimeoutMs 限制上传与下载。来源和分类信息与技能 Markdown 分开保存。

<a id="model-experience"></a>
## 模型体验

无，因为管理界面不登记面向模型的工具或目录，只编辑存储的指令文件与注册表状态。

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
