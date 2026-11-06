# Codex 订阅版本发布

[English](README.md) | 中文

## Summary

0.2.4：支持图片编辑蒙版及持久化图片任务句柄；恢复时复用已受理操作，并保存任务归属和取消回执，供节点画布工作流使用。

本包是随 AutoFlow 分发的独立 Host 插件，显示在已安装插件分区，保留已有启用选择。[release.config.json](../release.config.json) 负责稳定的 `codex-subscription-v<version>` 标签族和 `codex-subscription-update.json` 资产；AFP 与应用使用独立版本族。

## 准备与发布

阅读[发布 Skill](../../../../.agents/skills/dsh-custom-plugin-release/SKILL.md)和[发布规范](../../../release-governance/README.zh.md)。正式准备资产前先审核并提交源码：

```sh
pnpm --filter dsh-plugin-codex-subscription run release:prepare --out .artifacts/codex-subscription-release
```

准备流程运行本包测试和 prepack，检查声明的 Host/tools 入口、patch、图标、语言文件和许可说明，生成 tarball、`SHA256SUMS` 和更新元数据，不要求 Client 入口。元数据固定源码提交、版本、字节数和 SHA-256；`--allow-dirty` 仅作演练，不能用于正式发布。[自定义插件工作流](../../../../.github/workflows/release-custom-plugins.yml) 在四个原生平台检查，在无写入凭据的阶段准备资产，再从校验通过的草稿发布，并设置 `latest=false`。公开资产与版本标签保持冻结。

## 运行时更新

插件详情页复用既有的检查、更新和自动更新控件。自动安装须明确开启；安装不会自动启用插件或重启 AutoFlow。重启后加载新的 Host 实现，保留账号凭据、网关密钥、任务、配置和功能选择。运行时限额、摘要校验与 profile 本地缓存由既有插件管理器负责。

订阅设置页面归 AutoFlow 的模型设置包所有；本插件包含会话图片卡片和实时状态 Client。应用页面变化需要配套的 AutoFlow 构建。发布验证使用无密钥夹具，不执行真实订阅登录、生图或付费调用。按要求另行执行下载、安装或旧版本更新验收。

## Dev Note

无。

## Codex 订阅 0.2.3

Codex 图片模型可通过 AutoFlow 原生 LLM 图片接口供节点画布调用。桥接复用已有账号、图片任务和原图/预览附件；取消会停止已受理任务，不会再次提交。旧版支持宿主继续加载已有订阅功能，并明确提示新图片注册能力需要更新 AutoFlow 桌面端。本次配套桌面版本为 0.2.2-rc.1.20261105.3。

## Codex Subscription 0.2.0

本包在 Host 与工具之外包含会话图片卡片及实时图片任务状态。账号预检和额度报告区分账号不可用与请求失败，代理处理流式及 WebSocket 完成状态，不将未完成响应标为成功。已保存账号、凭据和任务保留在各自 profile 中；更新后需配套 AutoFlow 构建并重启。

## Codex Subscription 0.2.1

已安装插件列表使用更新后的图标。已有账号、凭据、任务和网关配置保留；更新后重启生效。
