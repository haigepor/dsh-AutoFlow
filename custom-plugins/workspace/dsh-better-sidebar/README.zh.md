---
description: "官方增强侧栏源码快照与独立的 AutoFlow 更新器。"
kind: "package-bundle"
---

# dsh-better-sidebar

[English](README.md) | 中文

## Summary

本工作区包含上游增强侧栏 v0.28.2 源码快照和独立装载的[更新器](updater/README.zh.md)。插件通过现有右侧栏注册接口提供文件编辑、Git 变更、任务和侧边对话，并拥有底部工作台。应用独立于两个组合包，为 `/sidebar` HTTP 和 WebSocket 请求提供鉴权。

## Use this package

在仓库根目录运行 `pnpm run build:sidebar`。源码启动和打包启动均从 `lib/` 提供已构建的客户端脚本。Web 与 Desktop 随应用交付两个包，与 AFP 一样在新建 profile 中默认启用。已有 profile 保留组合包选择和已保存的插件开关；需要时可在插件页面启用 **dsh-better-sidebar** 和 **dsh-plugin-better-sidebar-updater**。Desktop 恢复模式停用两个组合包并备份 profile patch，保留已安装包。主题偏好保持不变。关闭侧栏可恢复原生文件页和查看器注册。

插件接管原生 `files` 类型与可编辑文本资源。现有外框、分栏控件与主题仍由 AutoFlow 管理。PDF、图片、Office 和电子表格预览继续使用原生提供者。底部工作台由插件管理，初始收起。

Git 包含提交图与详情。JSONL 提供记录预览；超过 5 MiB 的文本使用只读分页查看器。底部终端各自持有独立实例，任务折叠提供四个独立开关。侧边对话实时更新，工作区服务可用时关闭页签会归档其子会话。未挂载会话通过存储 header 解析目录，不读取完整日志；已挂载会话跟随当前工作目录，同时保留仓库子目录。目录比较会解析 Windows 短路径、目录联接等别名，子目录仍保留原始路径写法。配置与扩展接口变化见[升级指南](../../../docs/upgrade-guide/v0.2.1-rc.3/better-sidebar-v0282/guide.zh.md)。

本地组合包通过侧栏的 `customCss` 设置应用 [file-changes.css](customizations/file-changes.css)：使用紧凑的下划线视图切换和轻量文件操作筛选。本地更新器 Client 测量选中按钮，使共享下划线与筛选背景在 240ms 内滑动并贴合按钮宽度。窗口尺寸和数量文字变化后重新对齐；减少动态效果偏好会取消过渡。更新器 Client 未启用时仍保留普通选中态过渡。已保存的 customCss 优先；清空该字段可使用上游外观。更新器在更新已启用的侧栏前，将当前字段保存到 profile。CSS 使用语义 ID 和角色，不绑定模块哈希；上游标记结构变化仍可能需要适配。

## Updates and ownership

更新器检查上游稳定 GitHub 发布，下载精确版本的 npm 发布包。新版安装到 profile，保留启用状态与 patch 配置。重启后 Host 与 Client 一起使用新版。即使上游后继包没有 AutoFlow 的 `updateManager` 字段，安装包中的声明仍为管理来源。

配套 SVG 图标使用圆角蓝色造型和薄荷绿点缀：侧栏为分栏窗口，更新器为环形箭头。[插件管理器的图标归属规则](../../../packages/boot/plugin-manager/README.zh.md)使官方 npm 后继包安装后继续显示应用提供的侧栏图标。

运行时更新不改写本工作区或打包应用。它替换实际运行的侧栏实现，包括本快照中的本地实现修改，不合并源码补丁。应用管理的鉴权、主题与布局修改位于更新的 npm 包之外。需要保留侧栏内部本地补丁时，应在安装前审查上游实现变化。[来源记录](UPSTREAM.md)说明导入版本。

本地设置页由独立伴随包 Client 提供；保存行为与更新兼容限制见[伴随包说明](updater/README.zh.md)。

Side Chat 通过 Host Agent 的持久化模型选择 API 切换模型。在 Agent 发布前的初始化作用域内安装切换提示，使新建和恢复的线程均在下一步应用所选路由。

## Model Experience

更新器不贡献模型提示词或工具。侧边对话创建独立 Agent，可以调用工具并产生模型用量。上游可选的 `sidebar_open` 工具由侧栏自身配置控制。

## Known Limitations and Deferred Work

上游文件路由采用 Host 用户权限，可访问工作区外路径。归档下载需要系统 `zip` 或 `tar`，并使用对应的文件扩展名。直接官方升级不保证保留本地修复。本次集成将上游实现与应用鉴权策略分开。

## Dev Note

源码保留 MIT 许可证。上游开发指令与仓库自动化未导入 AutoFlow。
