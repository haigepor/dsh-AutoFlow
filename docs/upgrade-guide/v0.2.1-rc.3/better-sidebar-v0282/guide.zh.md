---
kind: upgrade-guide
description: 增强侧栏改用流式文件传输、大文件分页预览及更新后的查看器和归档接口。
---

# 增强侧栏文件与查看器接口

[English](guide.md) | 中文

## 变更

随应用交付的增强侧栏为 v0.28.2。`readLimit`、`mediaLimit` 和 `uploadLimit` 不再限制文件传输。超过 5 MiB 的文本文件使用只读分页预览，较小文件仍可编辑。保存改用 raw `/sidebar/write` 路由；下载以流式发送，不再将完整文件读入内存。

文件查看器接收 `size` 和可选的 `largeFile` 信息，替代 `truncated`，并可通过 `onLineConsumed` 确认行号导航已消费。归档状态返回字节数，不再返回条目进度。归档调用系统 `zip` 或 `tar`，后者生成 `.tar.gz`。工作区服务可用时，关闭侧边对话页签会归档其子会话，持久化历史仍保留。

## 迁移

1. 从 profile patch 的增强侧栏行移除旧传输限制。旧字段仍可读取，但不再生效。保留 `listLimit` 及 `customCss` 等已保存偏好。
2. 按随包提供的[查看器声明](../../../../custom-plugins/workspace/dsh-better-sidebar/src/client/service.ts)更新扩展。处理 `largeFile` 时不能假定 `content` 存在；保存与归档状态使用当前[客户端 API](../../../../custom-plugins/workspace/dsh-better-sidebar/src/client/api.ts)。
3. 运行 `pnpm run build:sidebar`，将侧栏与本地设置伴随包一起构建和交付。伴随包包含导入版本的偏好解析器及目录数据；只更新上游 npm 包不会重新构建它。
4. 确认重新打开设置后任务折叠开关保持选中，Git／本轮文件切换与操作筛选保留本地样式，保存后的文件可以重新打开。核对归档使用当前可用的系统工具及对应扩展名。现有主题 token 和 profile 启用状态保持不变。
