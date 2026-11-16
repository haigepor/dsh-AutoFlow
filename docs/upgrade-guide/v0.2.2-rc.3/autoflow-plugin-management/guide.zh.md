---
kind: upgrade-guide
description: "AutoFlow 插件集成需要区分 Release 更新与 registry、Git 更新，并选择 profile MCP 设置入口。"
---

# AutoFlow 插件管理

[English](guide.md) | 中文

## 变更

`BundleInfo.update` 现在用 `registry` 或 `git` 标识官方更新方式。AutoFlow 独立 GitHub Release 状态改为 `BundleInfo.releaseUpdate`。插件页面分别投影为 `PackageView.updateKind` 与 `PackageView.update`。

默认 `@deepseek-ai/dsh-mcp-manager` 入口提供官方动态服务器管理。AutoFlow 的 profile 连接编辑通过 `@deepseek-ai/dsh-mcp-manager/settings` 提供 `ctx.mcpSettings`。已有直接 MCP 客户端条目及其密钥继续保存在 profile 中。

纯函数不再通过插件入口加载：技能文档解析改用 `@deepseek-ai/dsh-skill-filesystem/document`，原生图片和引用选择器改用 `@deepseek-ai/dsh-host-directory-picker-native/native-picker`。主题常量仍由包的 `src/theme-settings.ts` 源码导出及 Client API 提供；预览限制和标题规范化函数保留在包内部。技能管理插件的 schema 由 `SkillManagement.Config` 提供。

GitHub 桌面发布使用 `nightly.yml`、`policy.json` 保存开发版元数据，使用 `stable.yml`、`policy-stable.json` 保存正式版元数据；macOS 清单名包含 `-mac`。签名隔离与渠道选择相互独立。

## 迁移

1. 自定义清单消费者从 `releaseUpdate` 读取独立 Release 进度，只用 `update` 判断 registry 或 Git 更新资格。
2. 使用 profile 连接编辑的 composition 只挂载一次 `/settings` 入口；配置或插件动态注册的服务器由默认入口管理。不要复制或迁移已有直接 MCP 客户端到动态管理中。
3. 发布 GitHub 桌面包前选择 `DSH_DESKTOP_UPDATE_CHANNEL`，构建和发布使用匹配的完成记录及上一次渠道策略。两个渠道都发布后，设置中的两项选择才能分别提供下载。
4. 确认插件页面仍报告 Release 进度和重启状态，profile MCP 编辑保留原连接，桌面切换渠道时检查对应清单，不能安装旧渠道的下载。
5. 按新的辅助模块子路径重新构建自定义插件。同包测试直接导入内部辅助模块，纯解析和默认值读取不再通过插件入口。
