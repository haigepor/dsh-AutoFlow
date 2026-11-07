---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-background-task-conversation

[English](2026-11-06-background-task-conversation.md) | 中文

## 概述

为 Host 所属后台工作流新增仅用于展示的持久化 session/task 检查点。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-background-task-conversation
baseline: false
changes:
  - root: "event:session/task"
    previous: null
    after: "4a98531bdd213d072f55eec3c8fd13431abddb93ba86066e5bf2429a054b40bd"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有 Session 代际及事件载荷不变。新读取器继续读取没有任务检查点的日志，并保留原行为。新增必需事件采用独立的 session/task 判别值：旧读取器通过必需事件能力检查，在回放前安全拒绝，不应进入损坏恢复或尾部截断。检查点只保存展示事实，不是模型输入或执行命令。复制记录保留原所有者，不转移任务控制权。生产者来源版本对不确定的持久化确认进行去重，SESSION_FORMAT_VERSION 保持不变。

<a id="verification"></a>
## 验证

记录前已通过原生 Session Controller Host 及视觉策展 Host/Client 的聚焦 TypeScript 检查。回归源码覆盖重复检查点、持久化确认失败、原所有者保留、派发前展示、仅展示重试和停止后拒绝恢复。按用户要求未运行测试、构建、付费调用或实际界面验收。

<a id="dev-note"></a>
## 开发备注

无。
