---
description: "基于可复用 demo 开发和分发独立的 DSH 插件组合包。"
kind: "package-group"
---

# 自定义插件组合包

[English](README.md) | 中文

## Summary

在随主项目发布的 `packages/` 工作区之外开发组合包，并将其安装到 DSH profile。长期维护的正式插件放在[工作区](../workspace/README.zh.md)；[demo](demo/README.zh.md) 是可复制的参考 npm 包，演示可选提示词、Skill、可执行操作、Agent 工具和 Client UI。修改组件行或文件归属前，先阅读[架构文档](architecture.md)。

## Packages

- [workspace](../workspace/README.zh.md)：独立版本、正式开发插件包的源代码区域。
- [demo](demo/README.zh.md)：可运行的参考模板与本地安装步骤。
- [架构文档](architecture.md)：包目录、功能声明、UI 位置、文件生命周期与分发规则。

## Dev Note

无。
