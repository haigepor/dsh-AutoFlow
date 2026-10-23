---
description: "开发和分发独立版本的 DSH 插件组合包。"
kind: "package-group"
---

# 自定义插件组合包

[English](README.md) | 中文

产品独立版本、正式 Release 资产与历史标签保留规则见[发布规范](release-governance/README.zh.md)。

## Summary

在 `workspace/` 下开发长期维护的插件组合包，各 npm 包独立版本。AFP、增强侧栏和嵌套更新器显式纳入仓库 pnpm 工作区，并随 Web/Desktop 内置分发；两个侧栏包为可选组合包。本目录组织插件源码，本身不是待发布的包。修改组件行或文件归属前，先阅读[架构文档](architecture.md)。

## Table of Contents

- [Packages](#packages)
- [Structure](#structure)
- [Dev Note](#dev-note)

## Packages

- [增强侧栏](workspace/dsh-better-sidebar/README.zh.md)：上游快照与原生侧栏注册。
- [侧栏更新器](workspace/dsh-better-sidebar/updater/README.zh.md)：独立的官方版本检查与 npm 更新。

- [AFP 图片策展](workspace/dsh-plugin-afp/README.zh.md)：图片搜索、视觉策展与本地安装步骤。
- [AFP 版本发布](workspace/dsh-plugin-afp/release/README.zh.md)：有版本的 GitHub 产物和可复用发布流程。
- [视觉策展](workspace/dsh-plugin-visual-curator/README.zh.md)：随应用提供的风格版本、人工反馈、搜图和裁后复核。
- [架构文档](architecture.md)：包目录、功能声明、UI 位置、文件生命周期与分发规则。

## Structure

每个 `workspace/<plugin-name>/` 包含包清单、patch、Host 和可选 Client 入口、资源、测试与 README。目录名称使用小写 kebab-case，并尽量与 npm 包名的无作用域部分一致。包专属文档、测试和发布说明保留在对应插件目录；共用规则由架构文档统一维护。

## Dev Note

无。
