---
kind: upgrade-guide
description: "AutoFlow 的 GitHub 发布更新迁移至 updateBundleRelease，updateBundle 用于注册表版本更新。"
---

# 使用发布来源专属的更新方法

[English](guide.md) | 中文

## 变更

AutoFlow 插件管理器原来的 `updateBundle(name)` 检查并安装组合包声明的 GitHub 发布；现在改为 `updateBundleRelease(name)`。官方的 `updateBundle(name, version, options)` 将符合条件的注册表包更新至明确指定的较新版本，并返回安装及可能的恢复结果。调用旧单参数方法的自定义客户端必须迁移。更新来源、自动更新授权、启用选择与待重启状态保持不变。

## 迁移

1. 将单参数 GitHub 发布调用替换为 `pluginManager.updateBundleRelease(name)`，保留对 `ChangeResult` 和重启要求的处理。
2. 注册表更新先调用 `listVersions`，再调用 `updateBundle(name, version, options)`。检查 `result` 及可能存在的 `restore`，再报告成功。
3. 重新生成 Remote 声明并构建客户端。验证 GitHub 发布更新保留启用状态并要求重启，注册表更新仍保留版本选择和恢复反馈。
