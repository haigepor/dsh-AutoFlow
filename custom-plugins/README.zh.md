---
description: "开发和分发独立版本的 DSH 插件组合包。"
kind: "package-group"
---

# 自定义插件组合包

[English](README.md) | 中文

## Summary

在 `workspace/` 下开发长期维护的插件组合包，每个直接子目录对应一个独立版本的 npm 包。AFP 显式纳入仓库 pnpm 工作区，并随 Web/Desktop 内置分发；其他子包仍独立安装。本目录组织插件源码，本身不是待发布的包。修改组件行或文件归属前，先阅读[架构文档](architecture.md)。

## Table of Contents

- [Packages](#packages)
- [Structure](#structure)
- [Dev Note](#dev-note)

## Packages

- [AFP 图片策展](workspace/dsh-plugin-afp/README.zh.md)：图片搜索、视觉策展与本地安装步骤。
- [AFP 版本发布](workspace/dsh-plugin-afp/release/README.zh.md)：有版本的 GitHub 产物和可复用发布流程。
- [架构文档](architecture.md)：包目录、功能声明、UI 位置、文件生命周期与分发规则。

## Structure

每个 `workspace/<plugin-name>/` 包含包清单、patch、Host 和可选 Client 入口、资源、测试与 README。目录名称使用小写 kebab-case，并尽量与 npm 包名的无作用域部分一致。包专属文档、测试和发布说明保留在对应插件目录；共用规则由架构文档统一维护。

## Dev Note

无。
