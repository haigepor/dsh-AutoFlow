# 风格提示词发布

[English](README.md) | 中文

## 准备与发布

风格提示词使用独立的 `style-prompt-v<version>` 标签族。安装包包含 Host、Client、工作台、图标、语言文件和 profile patch。审阅并提交精确源码后运行 `pnpm --filter dsh-plugin-style-prompt run release:prepare --out .artifacts/style-prompt-release`。共享发布工作流检查原生平台，并以 `latest=false` 发布 tarball、SHA-256 列表和更新元数据。

## 运行时更新

插件页检查包声明的 GitHub 来源；自动安装需明确开启，安装不会自动重启应用。重启后加载新版，保留已保存的提示词、profile 配置和启用选择。无密钥的包测试不代表付费模型或真实图片来源已经验收。
