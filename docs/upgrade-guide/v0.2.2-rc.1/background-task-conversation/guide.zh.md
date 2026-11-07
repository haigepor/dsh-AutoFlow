---
kind: upgrade-guide
description: "后台工作流会话需要配套更新 Host，任务检查点需要支持 session/task 的读取器。"
---

# 后台工作流会话

[English](guide.md) | 中文

## 变更

视觉策展的结构化工作流此前在后台执行，会话正文没有消息。现在通过持久化的 `session/task` 检查点，在原生会话节点中展示确认需求、实际请求、进度、失败和交付。同步不提交额外提示词，不重复调用模型。既有 Session 代际和插件数据保持不变。

新结构化工作流需要 Host 专用的 `SessionController.recordTask` 能力，旧桌面无法通过插件 ZIP 获得。新读取器可以读取旧日志；旧读取器会安全拒绝含新增必需事件的日志。参见[持久化变更记录](../../../persistence-changes/2026-11-06-background-task-conversation.zh.md)。

## 迁移

1. 配套更新桌面 Host 与视觉策展，再重启 Host。本地源码验收在仓库运行 `pnpm run dev:desktop`，使用 `pnpm run dsh-plugin-visual-curator:local` 生成本地插件包。开发桌面沿用既有隔离开发 profile，只复制或导入需要的测试数据。
2. 打开工作流会话，无需发送消息即可看到已保存需求和已提交进度。重启后旧工作流会从检查点同步；“重试展示同步”只重新展示这些记录。需要继续执行时使用原任务的继续入口。
3. 在正文检查请求失败和结果目录。停止或删除工作流批次会停止执行并同步终态，保留的会话历史仍可查看。复制的任务记录应提示回到原会话控制任务。
4. 不要使用旧读取器打开含 `session/task` 的 Session。回退应用时保留新版读取器，或使用独立的更新前 profile 备份；不要为降级删除或改写 Session 事件。
