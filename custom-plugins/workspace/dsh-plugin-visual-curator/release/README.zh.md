# 视觉策展版本发布

[English](README.md) | 中文

## Summary

本包随 AutoFlow 分发，在已安装插件中展示，保留已有启用选择。[release.config.json](../release.config.json) 负责稳定的 `visual-curator-v<version>` 标签族和 `visual-curator-update.json` 元数据，与 AFP、应用分别发版。

## 准备与发布

阅读[发布 Skill](../../../../.agents/skills/dsh-custom-plugin-release/SKILL.md)和[发布规范](../../../release-governance/README.zh.md)。审核并提交源码后准备资产：

```sh
pnpm --filter dsh-plugin-visual-curator run release:prepare --out .artifacts/visual-curator-release
```

准备流程运行本包测试和 prepack，验证 Host、Client、tools、Skill 和 page 入口、patch、图标、语言文件与许可说明，生成 tarball、`SHA256SUMS` 和更新元数据。元数据固定源码提交、版本、字节数和摘要。`--allow-dirty` 只用于本地演练。[自定义插件工作流](../../../../.github/workflows/release-custom-plugins.yml) 在四个原生平台检查，再从已验证草稿发布，并设置 `latest=false`；公开资产与标签保持冻结。

## 运行时更新

插件详情页复用已有的检查、更新和自动更新控件。自动安装需明确开启，不会自动重启应用。重启后同时加载配套的 Host、Client 与 profile patch。已保存的风格、引用、任务、反馈、模型设置、凭据、启用及功能选择保留在各自的 profile 存储中。

tarball 需要 peerDependencies 声明的原生 LLM、附件、作业、存储和 Client 能力；应用拥有的组件需要配套 AutoFlow 构建。无密钥发布测试不代表真实图片来源登录、付费视觉调用或来源权限已经验收。按要求另行执行下载、安装和旧版本更新验收。

## Dev Note

无。
