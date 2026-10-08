---
name: dsh-custom-plugin-release
description: >-
  Prepare, publish and verify an independent custom DSH plugin GitHub Release, including AFP under custom-plugins/workspace/dsh-plugin-afp: review source, validate package version and tag, build a tarball, publish checksums and update metadata, and verify downloaded bytes. Use for AFP first releases, subsequent version releases, and failed release recovery. Do not use for runtime updater implementation, ordinary plugin installation, npm registry publication, AutoFlow application releases, or official upstream synchronization.
compatibility: Requires Git, the repository Node.js/pnpm runtime and an authenticated GitHub CLI; publication requires explicit user authorization.
---

# DSH 自定义插件发布

发布独立插件的 GitHub 版本，交付精确来源提交、tarball、SHA-256、版本元数据、Release 链接和验证记录。AFP 的配置与产物规则由[发布文档](../../../custom-plugins/workspace/dsh-plugin-afp/release/README.zh.md)和 [release.config.json](../../../custom-plugins/workspace/dsh-plugin-afp/release.config.json) 维护；先读这两个来源，不复制硬编码的当前版本。

## 触发与授权

- 用户只要求分析时，只读取和报告；不创建标签、推送或发布。
- 用户已要求发布时，执行准备、验证和发布，不再重复询问相同授权。实际缺少仓库、权限或版本决策时才询问，同时继续独立的准备工作。
- 本 Skill 只发布插件 GitHub Release。应用更新转交既有应用发布流程；官方集成使用 `autoflow-upstream-sync`。运行时自动更新是单独的工程任务。
- 创建或修改其他插件的发布适配器时，先确认其自己的版本、入口、依赖和配置，不直接套用 AFP 包名。

## 1. 核对来源与范围

1. 读取根 AGENTS、目标包清单、发布配置、README、来源记录和相关发布工作流。使用 `ponytail`、`windows-utf8-editing` 和 `dsh-pre-push-checks` 的当前规则。
2. 检查 `git status`、分支、remote、远程头、已有标签和 Release。区分本会话已授权改动与用户其他未提交改动；不得使用无差别 `git add .` 或覆盖用户源码。
3. 校验仓库写权限。优先用现有 GitHub CLI；找不到时检查已安装位置或使用官方可校验的临时工具。现有凭据只供匹配的 GitHub 主机使用，不打印、持久化或写入文档。
4. 确认包版本与标签完全匹配。首版可以沿用未发布的包版本；已公开版本不得重用。保留第三方来源记录，不推定缺失许可证，不据此向 npm 注册表发布。

## 2. 准备与验证

更新版本和用户可见文档，保持双语对与 sidecar 一致。发布通用库或 Host/Client API 改动时补齐消费者；只有发布脚本变化时不扩展到无关运行时重构。将新脚本的正例、错误标签、错误包名、缺失产物、哈希和脏树拒绝放入包所属测试。

AFP 从仓库根运行：

```sh
pnpm --filter dsh-plugin-afp run release:prepare --out .artifacts/afp-release
```

正式准备前提交审核后的完整源码。该命令负责测试、prepack 构建、包检查和资产元数据；不要重复运行已通过且未被后续编辑影响的检查。脏树演练可加 `--allow-dirty`，其产物不能上传发布。核对 `.tgz` 的声明入口、patch、featureConfig、图标、Skill 和 Client 文件，并检查没有 node_modules、测试、环境文件或本机凭据。

在独立临时 profile 中使用支持的 `dsh` 启动器安装/加载 tarball，检查 Host 代码、bundle 选择与配置，以及 Client 资源。不要在现有 Web/Desktop profile 覆盖同名内置包：当前安装优先级不能保证所有消费者共用 profile 新版。

更新文档配对记录，运行相关文档、语法与 Skill 元数据检查。遵循 `dsh-pre-push-checks` 选择必要的 build、lint、hygiene 和行为证据；平台基线失败要保留原始错误，不静默绕过钩子。

## 3. 发布精确源码

1. 检查提交后的 diff 与钩子产生的文件，确认只包含授权范围。推送不移动已有 tag，不使用 force；并发远程变化先重新评估，不能覆盖。
2. 将经过验证的来源提交及新的配置前缀标签推送到目标仓库。AFP 的 `release-afp.yml` 接收 `afp-v*` tag，并自动生成与发布产物。发布自动化的动作不得通过 PR 评论或其他通知替代。
3. 等待该 tag 的 prepare/publish 任务完成；检查失败日志并修复其原因。发布任务保持 `latest=false`，防止 AFP 改变应用更新入口。仅有普通 Git tag 不等于有可下载 Release。
4. 如果改用本地发布，使用已验证的干净来源产物，先建立 draft，上传并验证三项资产，再公开。不得把 GitHub 自动生成的全仓库源码压缩包当成 AFP npm 包。
5. 已存在公开 Release 时停止覆盖；发布新版本。恢复失败 draft 前，核对 tag、来源提交和已上传内容；只续传缺失的匹配资产，其他修改需要明确的范围依据。

## 4. 下载回验与交付

通过 Release API 确认公开状态、tag 提交和三个资产；下载到新目录，核对文件名、大小、SHA-256 与 `afp-update.json` 中的来源提交。必要时对下载包重复隔离 profile smoke，验证的是已发布字节。

最终给出 Release 链接、版本/tag/来源提交、产物及哈希、运行过的验证、剩余失败与恢复方式。明确 GitHub 发布渠道与运行时自动更新的实际状态；不得因 Release 存在就宣称插件页已支持自动更新。

新 Skill 运行 quick_validate 和 repository invocation metadata 检查。新会话发现与自动触发仍需在新会话中验证，不以文件存在替代加载证据。
