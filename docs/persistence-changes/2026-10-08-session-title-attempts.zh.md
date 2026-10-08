---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-08-session-title-attempts

[English](2026-10-08-session-title-attempts.md) | 中文

## 概述

新增脱敏的会话标题尝试记录及可选的请求思考强度字段。

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
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "36a261553f1759eb7a0c21b588c918b0e622e859ad7bd8de3b145d29c6c3e086"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有请求及标题记录在缺少新可选字段或尝试事件时仍可读取；新读取方识别新增的仅日志事件。写入格式版本和现有表面事件不变，不重写历史会话日志。

<a id="verification"></a>
## 验证

Host 与 Client TypeScript 编译及 86 项专项测试已通过，覆盖有限重试、取消、手动重命名、Remote 重新生成及失败后保留标题。持久化格式、类型等价及双语配对检查已通过。

<a id="dev-note"></a>
## 开发备注

无。
