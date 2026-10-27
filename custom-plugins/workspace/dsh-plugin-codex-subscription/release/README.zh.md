# Codex 订阅版本发布

[English](README.md) | 中文

## Summary

本包是随 AutoFlow 分发的独立 Host 插件，显示在已安装插件分区，保留已有启用选择。[release.config.json](../release.config.json) 负责稳定的 `codex-subscription-v<version>` 标签族和 `codex-subscription-update.json` 资产；AFP 与应用使用独立版本族。

## 准备与发布

阅读[发布 Skill](../../../../.agents/skills/dsh-custom-plugin-release/SKILL.md)和[发布规范](../../../release-governance/README.zh.md)。正式准备资产前先审核并提交源码：

```sh
pnpm --filter dsh-plugin-codex-subscription run release:prepare --out .artifacts/codex-subscription-release
```

准备流程运行本包测试和 prepack，检查声明的 Host/tools 入口、patch、图标、语言文件和许可说明，生成 tarball、`SHA256SUMS` 和更新元数据，不要求 Client 入口。元数据固定源码提交、版本、字节数和 SHA-256；`--allow-dirty` 仅作演练，不能用于正式发布。[自定义插件工作流](../../../../.github/workflows/release-custom-plugins.yml) 在四个原生平台检查，在无写入凭据的阶段准备资产，再从校验通过的草稿发布，并设置 `latest=false`。公开资产与版本标签保持冻结。

## 运行时更新

插件详情页复用既有的检查、更新和自动更新控件。自动安装须明确开启；安装不会自动启用插件或重启 AutoFlow。重启后加载新的 Host 实现，保留账号凭据、网关密钥、任务、配置和功能选择。运行时限额、摘要校验与 profile 本地缓存由既有插件管理器负责。

订阅页面归 AutoFlow 的模型设置包所有，不随本 Host tarball 分发；页面变化需要配套的 AutoFlow 构建。发布验证使用无密钥夹具，不执行真实订阅登录、生图或付费调用。按要求另行执行下载、安装或旧版本更新验收。

## Dev Note

无。
