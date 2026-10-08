## Why

AFP 已提供独立 GitHub Release，但插件页面没有远程版本查询、校验下载或更新安装能力；内置 bundle 与 profile 本地代码的加载优先级会使独立升级产生版本混用。仓库源码里程碑、插件和桌面端发行需要分别命名与维护，避免把无安装产物的历史记录用于更新。

## What Changes

- 自定义 bundle 声明 GitHub 稳定更新源，插件页面自动检查、手动安装更新，并提供持久化自动更新选择。
- 校验 Release 身份、版本元数据、下载地址、大小、SHA-256 与包内容后，通过现有 profile pnpm 安装事务执行更新；保留配置与启用状态，明确重启生效。
- 仅允许声明更新源的自定义内置 bundle 使用 profile 新版，统一 bundle patch、Host、Client 与资源的包选择，保留基础运行时包的规则。
- 记录现有 Tags 与 Releases，建立插件、桌面安装包和历史源码里程碑的独立命名、说明、资产及归档规范；不覆盖公开发行资产或移动已有发行标签。

## Capabilities

### New Capabilities

- `plugin-github-updates`: 远程查询、下载校验、安装、自动更新设置及重新启动后的一致加载。
- `release-governance`: 独立插件和桌面端发行规则，以及历史 Tags/Releases 的可恢复归档方案。

### Modified Capabilities

无现有主规格需要修改。

## Impact

涉及 package-manifest 类型、app-boot bundle 解析、plugin-manager Host/RPC、ui-plugin-manager Client、AFP 更新源配置、相关测试及双语发布文档。更新源与安装包均视为外部输入；不更改 Agent loop、Session 格式、应用配色、Windows 签名与现有桌面更新提供方，不在本任务中发布新的插件或 Windows 安装包。远程历史记录删除或标签迁移须依据完成的清单取得具体授权。
