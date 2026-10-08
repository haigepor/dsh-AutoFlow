---
kind: upgrade-guide
description: "AFP 随 Web/Desktop 交付，无需在 profile 内另行安装。"
---

# AFP 随 Web/Desktop 内置交付

[English](guide.md) | 中文

## 变更

仓库 workspace 与 CLI 生产依赖包含 `dsh-plugin-afp`。新建 Web/Desktop profile 会自动选中它。AFP 保留独立包版本，不再声明 DSH 精确 peer 版本。根构建会重建浏览器入口，Desktop 打包会包含其 tarball。

## 迁移

在仓库根目录运行 `pnpm install` 与 `pnpm run build`，随后重启 Host。已有 bundle 选择保持原样：需要启用 AFP 时，在 profile 的 `package.json` 中把 `dsh-plugin-afp` 加入 `dsh.profile.bundles`。保留已有用户 patch 与功能配置。

如果 profile 已安装 AFP，先备份 manifest 与 lockfile，再执行 `pnpm --dir <profile-directory> remove dsh-plugin-afp --config.ignore-scripts=true`。保留 `dsh.profile.bundles` 中的 AFP；否则本地已安装副本会优先于内置模块。这条包管理器命令移除旧依赖，不修改 bundle 选择或用户 patch。

保留 `<profile>/.plugins/dsh-plugin-afp/config.json`、`$DSH_HOME/.plugins/dsh-plugin-afp` 下的 AFP 状态及已保存凭据。包内 `config.json` 提供初始功能默认值，不覆盖已保存选择或创建凭据。确认 AFP 装载时没有版本警告，且操作台能打开。Headless 与 SDK 默认配置保持原样。
