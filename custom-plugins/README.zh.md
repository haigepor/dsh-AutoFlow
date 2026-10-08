---
description: "基于维护中的示例开发和分发独立 DSH 插件组合包。"
kind: "package-group"
---

# 自定义插件组合包

[English](README.md) | 中文

## Summary

在随主项目发布的 `packages/` 工作区之外开发组合包，并将其安装到 DSH profile。长期维护的正式插件放在[工作区](workspace/README.zh.md)；[AFP 图片策展](workspace/dsh-plugin-afp/README.zh.md) 是维护中的组合包示例，包含 Skill、可执行操作、Agent 工具和 Client UI。修改组件行或文件归属前，先阅读[架构文档](architecture.md)。

## Packages

- [workspace](workspace/README.zh.md)：独立版本、正式开发插件包的源代码区域。
- [AFP 图片策展](workspace/dsh-plugin-afp/README.zh.md)：图片搜索、视觉策展与本地安装步骤。
- [架构文档](architecture.md)：包目录、功能声明、UI 位置、文件生命周期与分发规则。

## Dev Note

无。
