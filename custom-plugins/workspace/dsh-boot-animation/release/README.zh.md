# 启动动画发布

[English](README.md) | 中文

## 准备与发布

AutoFlow 适配保留上游 BSD 3-Clause [许可](../LICENSE)，包括内置媒体的许可说明，使用独立的 `boot-animation-v<version>` 标签族。安装包包含 Host、Client、所选视频、图标和 profile patch。审阅并提交精确源码后运行 `pnpm --filter dsh-boot-animation run release:prepare --out .artifacts/boot-animation-release`。共享发布工作流检查原生平台，并以 `latest=false` 发布 tarball、SHA-256 列表和更新元数据。

## 运行时更新

插件页检查包声明的 GitHub 来源，自动安装需明确开启。重启后加载新版 Host 和 Client，并保留 profile 的启用状态及设置。应用启动时的早期展示和随包视频还属于 Desktop/Web 构建，这些资源变化需要配套应用版本。Release 成功本身不代表旧版应用的更新路径已经验收。
