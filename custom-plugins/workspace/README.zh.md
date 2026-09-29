---
description: "开发可长期维护且独立版本化的 DSH 插件组合包。"
kind: "package-group"
---

# 正式插件工作区

[English](README.md) | 中文

## Summary

每个直接子目录创建一个正式维护的插件组合包。每个子目录都是独立 npm 包；本目录只负责组织源码，不是 pnpm workspace，也不是可发布的包。

## Structure

- `<plugin-name>/`：一个独立版本的 npm 组合包，包含 package manifest、patch、Host 和可选 Client 入口、资源、测试及 README。
- `../demo/`：可复制的运行参考；复制后替换包身份、UI 文案、功能声明及受管内容标记。

目录使用小写 kebab-case，并在可行时与 npm 包名的非 scope 部分一致。每个插件的文档、测试和发布说明都留在其自身目录；共享规则见[上级架构文档](../architecture.md)。

## Dev Note

无。
