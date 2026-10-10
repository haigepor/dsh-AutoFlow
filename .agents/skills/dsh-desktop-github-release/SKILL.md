---
name: dsh-desktop-github-release
description: >-
  构建、打包并发布 AutoFlow / DeepSeek Harness 桌面安装包，用 GitHub Releases 承载安装包，GitHub Pages 承载更新策略和自动升级清单。用于 Windows 无签名测试包、已有凭据的正式签名包、后续桌面发布与失败恢复。不用于 AFP 独立插件发布、npm 发布、上游同步或单纯更新服务分析。
compatibility: Windows x64 打包需 Node.js、pnpm、Visual C++ 和 Windows SDK；发布需公开 GitHub 仓库及 Contents/Pages 写权限。签名构建另需已有证书。
---

# 桌面 GitHub 构建与发布

交付可安装桌面包、精确来源提交、SHA-256、Release 链接和 Pages 策略。字段与入口由 [Desktop README](../../../apps/desktop/README.zh.md)、[平台模板](../../../apps/desktop/.env.github.windows.example)、[产物校验器](../../../apps/desktop/scripts/desktop-github-publication.ts)和[发布脚本](../../../apps/desktop/scripts/publish-github.ts)维护。

## 触发与范围

- 只要求分析时不创建标签或发布。用户要求构建、提交或发布时完成对应已授权步骤，不重复询问相同授权。
- 默认构建 Windows x64 无签名测试包。没有真实证书时不伪造签名、不声称完成签名验证，继续独立的无签名构建。正式签名沿用现有硬件签名配置。
- 沿用用户确定的版本；否则根据 Desktop 清单及已有 Release 选择未占用的构建号。用 `--build-version` 传递版本，不改动运行时清单版本。
- AFP 独立插件发布使用 `dsh-custom-plugin-release`。macOS 必须使用对应 macOS 主机，保留 Apple 签名和公证要求。
- 默认不追加发布后的隔离安装或完整重装演练。打包内置 smoke、附件校验与公开地址检查通过即可；用户要求或诊断失败时再追加安装升级验证。

## 1. 读取和预检

读取根 AGENTS、Desktop README、相关测试和发布配置。加载 `ponytail`、`windows-utf8-editing`；提交推送前使用 `dsh-pre-push-checks`。检查工作区、远程头和来源提交，保护用户其他改动，不使用 `git add .`。

不存在 `.env.windows` 时复制 `.env.github.windows.example`；存在时先读取，保留配置和凭据。更新仓库与 Pages URL，策略 URL 必须是同目录 `policy.json`。无签名升级要求 `DSH_DESKTOP_UNSIGNED_UPDATES=1`、独立应用 ID 和 `/unsigned/` 目录；正式通道移除该开关，使用其他 Pages 目录及签名配置。

不打印 PIN、密码、私钥、Token 或完整 credential-helper 输出。发布脚本读取进程 `GITHUB_TOKEN`／`GH_TOKEN` 或 Git Credential Manager；Token 不放入平台 dotenv、安装包或项目文件。

从仓库根运行，将已确定的版本保存在 `$desktopBuildVersion`：

```powershell
pnpm --dir apps/desktop run check:package --unsigned --build-version $desktopBuildVersion
pnpm exec vitest run apps/desktop/tests/github-update-policy.spec.ts apps/desktop/tests/desktop-github-publication.spec.ts
```

预检失败时保留精确错误，修复实际缺失依赖或配置，不填假地址、不跳过检查。正式签名预检省略 `--unsigned`，签名凭据就绪后才执行签名。

## 2. 构建与打包

```powershell
pnpm --dir apps/desktop run package:win:x64:unsigned --build-version $desktopBuildVersion
```

命令执行官方构建、运行时准备、AFP 打包、NSIS 构建和产物 smoke。无签名输出在 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/`，正式输出在同目标 `artifacts/`。检查唯一 `packaging-runs` 记录：退出码必须为零，安装包非空，feed 与 completion record 齐全。公开发布使用干净已提交源码构建的产物；脏工作区允许本地构建，但发布脚本拒绝为其创建公开版本。必要的源码提交和推送须在用户已授权范围内完成。

## 3. 准备与发布

```powershell
pnpm --dir apps/desktop run publish:github win-x64 --prepare-only
pnpm --dir apps/desktop run publish:github win-x64
```

准备步骤读取此前策略，校验 completion record、版本、目标、文件名、SHA-512 和附件。首次策略默认以首次安装包版本为最低支持版本；后续保留原最低版本。仅在用户明确要求淘汰旧版本时传入 `--minimum-supported-version <版本>`，不随普通发布提高强制阈值。

发布先上传并公开不可变附件，验证 GitHub SHA-256 和匿名下载地址，再将 feed 与策略共同提交到专用 `desktop-updates` 分支。遇到已有文档 Pages 站点时停止，不覆盖。正式标签为 `desktop-v<版本>`，无签名标签为 `desktop-v<版本>-unsigned`；不读取仓库 `releases/latest`，避免选中 AFP。

可使用手动 `Publish Windows Desktop` Actions workflow，在原生 Windows runner 上执行同一流程。它隔离构建与发布凭据；检查 run 最终状态后才报告成功。

## 4. 验证与交付

等待 Pages 构建完成，匿名读取策略和分平台 feed，确认版本、最低阈值、Release 标签和附件匹配。Pages 未生效或权限不足时分别报告 Release 与策略状态；保留已发布附件，修复后重试，不删除或移动公开标签、不覆盖不同哈希的附件。分支并发移动时读取最新策略重新准备，不强推。

中文交付安装包绝对路径、大小、SHA-256、构建提交、签名状态、Release／策略链接和实际验证结果。无签名通道校验 SHA-512，没有证书发布者校验；自动检查与下载沿用客户端机制，安装仍需二次确认。真实签名或安装升级演练未执行时明确列出，不用脚本测试代替其证据。

## 失败恢复

保留运行日志和 publication.json，回到最早失败步骤。安装包失败时不推进策略；策略发布失败时保留公开安装包并重试。以专用分支的新提交修复策略，不强制降级已安装应用。脚本拒绝降低版本和最低阈值；紧急解除错误强制策略需单独明确授权并审查。
