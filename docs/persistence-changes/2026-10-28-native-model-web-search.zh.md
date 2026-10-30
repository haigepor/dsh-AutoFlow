---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-28-native-model-web-search

[English](2026-10-28-native-model-web-search.md) | 中文

## 概述

在提供方发出请求前记录模型原生联网搜索的辅助输入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-28-native-model-web-search
baseline: false
changes:
  - root: "event:web/native-search-llm-request"
    previous: null
    after: "7195fba1ffaa67e485ea93f1d2231fbda86babc0d7c5ea72ae8b26c70a869b58"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有会话记录仍然有效。新增的 web/native-search-llm-request 判别值记录不含凭据的辅助输入，不改变会话消息投影。不认识此必需事件的旧读取方会明确拒绝，不会误读为其他事件。已发布的代际和现有判别值均未修改。

<a id="verification"></a>
## 验证

pnpm run build:check 的两项聚合检查通过。tool-web 原生搜索测试在发出请求前记录并快照校验新事件；DeepSeek、Responses 和 Codex 账号夹具验证当前模型的凭据复用与结构化来源。

<a id="dev-note"></a>
## 开发备注

无。
