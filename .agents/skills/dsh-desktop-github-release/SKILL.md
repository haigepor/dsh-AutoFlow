---
name: dsh-desktop-github-release
description: >-
  通过现有 GitHub Actions 或本地流程构建并发布 AutoFlow / DeepSeek Harness 桌面包，支持 Windows x64、macOS Apple Silicon 与 Intel、无证书测试更新及已有凭据的正式签名。核验不可变 Release 附件、分平台 Pages 自动更新和失败恢复。不用于自定义插件独立发布、npm 发布、上游同步或单纯更新服务分析。
compatibility: GitHub 构建使用对应原生 runner 和仓库锁定的 Node.js/pnpm；发布需公开仓库及 Contents/Pages 写权限。本地 Windows 打包另需 Visual C++/Windows SDK；正式 macOS 签名和公证需已有 Apple 凭据。
---

# 桌面 GitHub 构建与发布

交付可安装桌面包、精确来源提交、SHA-256、Release 链接和 Pages 策略。字段与入口由 [Desktop README](../../../apps/desktop/README.zh.md)、[平台模板](../../../apps/desktop/.env.github.windows.example)、[产物校验器](../../../apps/desktop/scripts/desktop-github-publication.ts)和[发布脚本](../../../apps/desktop/scripts/publish-github.ts)维护。

## 触发与范围

- 只要求分析时不创建标签或发布。用户要求构建、提交或发布时完成对应已授权步骤，不重复询问相同授权。
- 默认构建 Windows x64 无签名测试包。没有真实证书时不伪造签名、不声称完成签名验证，继续独立的无签名构建。正式签名沿用现有硬件签名配置。
- 沿用用户确定的版本；否则根据 Desktop 清单及已有 Release 选择未占用的构建号。用 `--build-version` 传递版本，不改动运行时清单版本。
- 五种自定义插件独立发布使用 `dsh-custom-plugin-release`。macOS 两种架构分别使用现有原生工作流；用户允许无证书时可选择隔离的 ad-hoc 测试更新渠道，不能声称 Developer ID、Apple 发布者认证或公证完成。正式签名模式保留原有要求。
- 用户要求 GitHub 打包时使用下述现有 Actions，先核对历史成功运行及当前输入，不改用上游 COS 或自托管发布工作流，不要求用户提供本次模式无需使用的证书。
- 默认不追加发布后的隔离安装或完整重装演练。打包内置 smoke、附件校验与公开地址检查通过即可；用户要求或诊断失败时再追加安装升级验证。

## 1. 读取和预检

读取根 AGENTS、Desktop README、相关测试和发布配置。加载 `ponytail`、`windows-utf8-editing`；提交推送前使用 `dsh-pre-push-checks`。检查工作区、远程头和来源提交，保护用户其他改动，不使用 `git add .`。

按[更新说明流程](../../../apps/desktop/release-notes/README.zh.md)检查日常条目，合并同一问题、删去未完成或无用户影响的内容，整理新增功能、体验优化、问题修复和其他变更。执行 `node --import tsx/esm apps/desktop/scripts/release-notes.ts <精确构建版本>` 后审阅对应 `releases/<版本>.json`，在用户授权的源码提交中包含它，再打包；没有提交授权时完成整理并报告待提交，不发布。已发布版本的说明不覆盖，需要纠正时使用新版本。

本地 Windows 构建不存在 `apps/desktop/.env.windows` 时复制 `.env.github.windows.example`；存在时先读取，保留配置和凭据。更新仓库与 Pages URL，策略 URL 必须是同目录 `policy.json`。无签名升级要求 `DSH_DESKTOP_UNSIGNED_UPDATES=1`、独立应用 ID 和 `/unsigned/` 目录；正式通道移除该开关，使用其他 Pages 目录及签名配置。GitHub macOS 构建使用下文的 runner 私有配置，无需准备本地 Windows 环境。

不打印 PIN、密码、私钥、Token 或完整 credential-helper 输出。发布脚本读取进程 `GITHUB_TOKEN`／`GH_TOKEN` 或 Git Credential Manager；Token 不放入平台 dotenv、安装包或项目文件。

本地 Windows 预检从仓库根运行，将已确定的版本保存在 `$desktopBuildVersion`；仅发布 macOS 时不执行本段：

```powershell
pnpm --dir apps/desktop run check:package --unsigned --build-version $desktopBuildVersion
pnpm exec vitest run apps/desktop/tests/github-update-policy.spec.ts apps/desktop/tests/desktop-github-publication.spec.ts
```

预检失败时保留精确错误，修复实际缺失依赖或配置，不填假地址、不跳过检查。正式签名预检省略 `--unsigned`，签名凭据就绪后才执行签名。

Windows Office helper 需要随包分发的 Microsoft x64 CRT，预检验证文件版本、架构和 Microsoft 签名；默认从 Visual Studio Redist 查找，可用平台 dotenv 的 `DSH_DESKTOP_WINDOWS_CRT_DIR` 指定完整目录。桌面更新维护这些应用私有 DLL，不修改系统运行库。

## 2. GitHub 构建与打包

沿用 [Publish Windows Desktop](../../../.github/workflows/desktop-release.yml)：传入精确 `version`，`publish=true` 构建并发布；`publish=false` 只保留 artifact。发布不传最低版本参数时保留已有策略，不自动提高强制更新阈值。

macOS 沿用 [Build macOS Desktop artifacts](../../../.github/workflows/desktop-macos-build.yml)，分别选择 `target=mac-arm64` 和 `target=mac-x64`。版本和 `expected_commit` 必须精确对应已经推送到 `main` 的干净源码；运行器、Node.js 和 Xcode 由该工作流维护，pnpm 由根包清单锁定，不另填历史 pnpm 版本。

用户允许无证书且要求自动更新时，明确传入 `deployment=test`、`signing=unsigned`、`unsigned_updates=true`。环境 `desktop-macos-test` 的公开变量 `DESKTOP_UNSIGNED_APP_ID` 必须使用稳定、以 `.unsigned` 结尾的独立 ID。工作流创建并清理 runner 私有配置，无需 Apple Secrets。普通 `--unsigned` 构建默认关闭更新，不能把它误当成已启用更新的产物；正式 `signed` 模式仍需原有证书和公证凭据。

等待每次运行最终成功，核对原生架构、Squirrel 私有测试应用下载/替换/重启资格测试、最终应用严格嵌套代码验签、稳定 identifier 要求、打包 smoke、来源记录与 `SHA256SUMS`。默认 ad-hoc 的逐构建 cdhash 不能用于跨版本升级；验签或资格测试失败时修复实际封装原因，不关闭检查。资格测试只替换 runner 私有 fixture，不执行用户电脑的真实安装器。

macOS 构建工作流只保留产物。随后按目标依次触发 [Publish verified macOS Desktop artifacts](../../../.github/workflows/desktop-macos-publish.yml)，传入成功的构建 `run_id`、同一 `target`、`version` 和构建的 `expected_commit`，等待前一目标发布完成。该工作流校验主分支构建状态、工作流、提交、artifact 名称及 GitHub archive SHA256，再核验解包后的 `SHA256SUMS`，调用既有发布器；不重新构建，不经过本机搬运大包，不执行 artifact 中的程序。发布凭据只提供给 Actions 的必要步骤，依赖安装不运行构建脚本。

发布工作流与 Windows 共用 `desktop-github-publication` 队列；不要同时堆积多次发布，因为 GitHub 会替换同组较早的待运行任务。公开 Release、最新策略和 feed 全部核验成功后，才报告已交付自动更新；构建成功或存在 artifact 不能替代发布成功。

### 本地 Windows 入口

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\apps\desktop\scripts\build-windows.ps1 -BuildVersion $desktopBuildVersion
```

一键脚本按自身路径定位仓库，保留现有平台配置，安装缺失依赖并执行预检。省略 `-BuildVersion` 时生成带 UTC 时间戳的版本；`-CheckOnly` 只执行预检。成功时最后一行打印非空安装包绝对路径及前面的 SHA-256，失败时退出码非零，不打印成功。脚本默认不签名、不发布。

打包执行官方构建、运行时准备、AFP 打包、NSIS 构建和产物 smoke。无签名输出在 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/`，正式输出在同目标 `artifacts/`。检查唯一 `packaging-runs` 记录：退出码必须为零，安装包非空，feed 与 completion record 齐全。公开发布使用干净已提交源码构建的产物；脏工作区允许本地构建，但发布脚本拒绝为其创建公开版本。必要的源码提交和推送须在用户已授权范围内完成。

## 3. 准备与发布

```powershell
pnpm --dir apps/desktop run publish:github win-x64 --prepare-only
pnpm --dir apps/desktop run publish:github win-x64
```

准备步骤读取此前策略，校验 completion record、版本、目标、文件名、SHA-512 和附件，并从 completion record 的构建提交读取对应版本更新说明；缺失、未完成或版本不符时停止。Release 正文和官方 feed 的 `dshReleaseNotes` 来自同一份条目。首次策略默认以首次安装包版本为最低支持版本；后续保留原最低版本。仅在用户明确要求淘汰旧版本时传入 `--minimum-supported-version <版本>`，不随普通发布提高强制阈值。

发布先上传并公开不可变附件，验证 GitHub SHA-256 和匿名下载地址，再将 feed 与策略共同提交到专用 `desktop-updates` 分支。遇到已有文档 Pages 站点时停止，不覆盖。正式标签为 `desktop-v<版本>`，Windows 无签名标签为 `desktop-v<版本>-unsigned`；无证书 Mac 分别为 `desktop-v<版本>-mac-arm64-unsigned`、`desktop-v<版本>-mac-x64-unsigned`。不向已公开的 Windows Release 补传 Mac 资产，不读取仓库 `releases/latest` 选择桌面版本。

## 4. 验证与交付

等待 Pages 构建完成，匿名读取策略和所有本次发布平台的 feed，确认版本、最低阈值、Release 标签和附件匹配，并复查其他平台策略及 `plugins/stable/index.json` 保留。当前可选测试更新保留 `minimumSupportedVersion=0.0.0`。Pages 未生效或权限不足时分别报告 Release 与策略状态；保留已发布附件，修复后重试，不删除或移动公开标签、不覆盖不同哈希的附件。分支并发移动时读取最新策略重新准备，不强推。

中文交付可用下载地址或本地产物绝对路径、大小、SHA-256、构建提交、签名状态、Release／策略链接和实际验证结果。无签名通道校验 SHA-512，没有证书发布者校验；自动检查与下载沿用客户端机制，安装仍需二次确认。真实签名或安装升级演练未执行时明确列出，不用脚本测试代替其证据。

如果交付包含下载弹窗修复，区分“关闭进度窗后再次打开”和“前台完成后自动出现安装确认”；完成确认先于 Host 重启准备，用户批准安装后仍检查活动任务并单独取得停止任务的同意。只报告实际跑过的对应回归。旧版宿主的更新缺陷不会因发布新插件而修复；此前关闭自动更新的无证书 Mac 包需要手动安装一次新宿主才能进入该渠道。

## 失败恢复

若 npm 大包超时后出现 `missing required LibreOffice engine win32-x64`，保留失败记录；可在平台 dotenv 配置已有 `DSH_DESKTOP_NPM_REGISTRY=https://registry.npmmirror.com`，先确认镜像包与 npm 官方 `dist.integrity` 相符，再重跑完整打包。不要删除 Office 组件、跳过完整性检查或仅重用不完整运行时。

保留运行日志和 publication.json，回到最早失败步骤。安装包失败时不推进策略；策略发布失败时保留公开安装包并重试。以专用分支的新提交修复策略，不强制降级已安装应用。脚本拒绝降低版本和最低阈值；紧急解除错误强制策略需单独明确授权并审查。
