---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-08-session-title-attempts

[English](2026-10-08-session-title-attempts.md) | 中文

## 概述

在官方标题请求声明之外保留脱敏的本地会话标题尝试记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-session-title-attempts
baseline: false
changes:
  - root: "event:session/title-llm-attempt"
    previous: null
    after: "e5ae9f18f9da222773c06af817e9d4694cf85f213a03f4e462af4e4071686ed7"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

标题请求类型与官方声明一致，不需要额外的分支类型变更。本地确认只新增用于日志的尝试事件，不进入模型输入。不认识该必需事件的旧读取器会拒绝会话。官方确认、写入版本和已提交的历史会话日志代际保持不变。

<a id="verification"></a>
## 验证

pnpm exec tsx scripts/compile-referenced-projects.ts host-contracts 和 pnpm exec tsc -b tsconfig.client.json 通过。session-title-llm 的 llm.spec.ts 聚焦运行通过 20 项测试，覆盖有界瞬时故障重试、终止认证失败、取消、操作流故障、脱敏尝试记录及提供商推理强度选择。

<a id="dev-note"></a>
## 开发备注

无。
