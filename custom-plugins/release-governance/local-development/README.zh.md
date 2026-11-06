# 插件与桌面端本地测试

[English](README.md) | 中文

## Summary

在已安装桌面端测试插件修改时，使用本地插件包，无需等待 GitHub；修改应用或宿主时，使用桌面源码预览。所有命令均在已安装 workspace 依赖的仓库根目录执行。[根脚本](../../../package.json)定义命令名，[发布规范](../README.zh.md)负责公开版本与不可变资产要求。

## 选择命令

每个支持的插件分别提供正式发布和本地打包命令：

| 插件 | 正式 GitHub 发布 | 本地打包 |
|---|---|---|
| 视觉策展 | `pnpm run dsh-plugin-visual-curator` | `pnpm run dsh-plugin-visual-curator:local` |
| AFP | `pnpm run dsh-plugin-afp` | `pnpm run dsh-plugin-afp:local` |
| Codex 订阅 | `pnpm run dsh-plugin-codex-subscription` | `pnpm run dsh-plugin-codex-subscription:local` |
| 风格提示词 | `pnpm run dsh-plugin-style-prompt` | `pnpm run dsh-plugin-style-prompt:local` |
| 启动动画 | `pnpm run dsh-boot-animation` | `pnpm run dsh-boot-animation:local` |

本地打包默认允许未提交修改，将所选插件构建到隔离目录，检查声明入口与依赖，计算 SHA256，输出进度和 `.tgz` 绝对路径。它不访问 GitHub，不运行原生平台矩阵，不安装插件，不重启桌面端，也不修改源码清单。快速模式保持工作区生成文件不变。添加 `--full-checks` 可在打包前运行本包已有的 `check` 和 `test`；这些命令保留原有构建副作用。

```sh
pnpm run dsh-plugin-visual-curator:local
pnpm run dsh-plugin-visual-curator:local --out .artifacts/manual-plugin-tests
pnpm run dsh-plugin-visual-curator:local --full-checks
pnpm run dsh-plugin-visual-curator --help
```

本地产物包含版本唯一的安装包、`SHA256SUMS` 和 `local-build.json`。记录中包含源码提交、未提交修改标记、基线版本和实际检查范围，不作为 GitHub 更新元数据。默认目录为 `.artifacts/plugins/<package>/local/<local-version>/`；`--out` 替换产物根目录，仍保留唯一版本子目录。构建期间不要继续编辑源码，也不要覆盖已有包文件。测试 profile 仍引用包的绝对路径时，保留该文件。

## 在已安装桌面端测试

这条路径使用已有的插件安装表单，不依赖专门的本地文件选择器。

1. 修改插件，运行对应 `:local` 命令，复制输出的 `.tgz` 绝对路径。
2. 在插件的版本更新面板关闭“自动下载安装”，用于本轮本地测试；仍可手动检查正式更新。
3. 打开插件安装，在“包名或地址”输入框粘贴绝对路径，核对安装结果并安装。路径不带 shell 引号。输入包路径，而非已安装插件的包名；仅输入包名会被视为已经安装。
4. 按提示重启。不支持 HMR 的替换在重启前仍运行已经加载的版本；重启后核对 `-local` 版本，并验收改动功能。
5. 后续修改重复打包与替换，保持包名和功能 ID，不把卸载作为常规测试步骤。

安装器接受绝对 `.tgz`、`.tar.gz` 路径及 `file:` 包规格。替换行为由[插件管理器](../../../packages/boot/plugin-manager/README.zh.md)及[替换回归](../../../packages/boot/plugin-manager/tests/package-reload.spec.ts)负责。该表单是当前可用的手动路径，不提供 Dev Note 中设计的专用导入预览。测试持久化、兼容性或失败恢复时，使用隔离的开发 profile。

## 本地版本与正式更新

本地包使用 `<源码版本>-local.<UTC YYYYMMDDHHmmss>.<毫秒>`，例如 `0.2.13-local.20261105103000.123`，仅修改隔离目录中的包清单。保留原有 `dsh.bundle.update`、仓库、正式标签族和元数据资产名。

正式版 `0.2.13` 的优先级高于基于 `0.2.13` 的本地构建，更高正式版本也能继续被检测；低于基线的正式版不会成为自动降级目标。因此本地测试时需暂停自动安装，否则已有的同基线正式版可能马上替换本地包。准备切回时点击“检查更新”，安装正式版本并重启；正式清单不再包含 `-local`。当前界面展示已安装版本，尚无独立的“本地构建”标签。

不要改用下一补丁 beta 版本或 SemVer 的 `+local` 构建元信息：前者会改变版本优先级，当前更新器又要求规范化后的 SemVer 与安装版本字符串完全一致。上述本地后缀满足现有检查。若测试时需要继续提供当前已发布基线的正式更新，先保留源码基线版本，准备正式发布时再升版。

## 发布正式版本

无 `:local` 后缀的命令用于审核后的公开分发，不会自动升版、提交或推送分支。

1. 将目标包清单设为新的稳定 `x.y.z`，更新发布说明及受影响双语文档；已经公开的版本不能复用。
2. 审核预期修改，运行相关检查，提交并推送源码分支。脏工作区或远端分支与 `HEAD` 不一致时拒绝发布。
3. 运行正式命令。它核对插件发布配置，将配置中的标签冻结到 `HEAD`，跟踪对应原生 Actions 工作流，核对公开元数据与资产摘要，再等待已部署官方索引包含完全一致的版本。
4. 只有公开 Release 与官方索引均报告就绪才算完成。Actions 已校验完整安装包，命令不重复下载整包，也不修改公开附件。

```sh
pnpm run dsh-plugin-visual-curator --plan
pnpm run dsh-plugin-visual-curator
pnpm run dsh-plugin-visual-curator --retry
```

`--plan` 仅展示本地源码和版本信息，不需要凭据或远程写入。正式发布使用 `GH_TOKEN`、`GITHUB_TOKEN` 或已有 Git Credential Manager 登录，要求 Contents 与 Actions 写权限；凭据不会写入产物。`--retry` 续跑失败的原生任务，并触发可信官方索引发布器，不移动标签。`--timeout-minutes` 修改默认 60 分钟的有界等待。失败时使用输出的工作流或 Release 链接定位恢复；Release 成功而索引未就绪时仍报告发布未完成。

旧参数 `--prepare-only [--allow-dirty]` 映射到本地打包，日常操作和脚本优先使用 `:local`。单独的 `--allow-dirty` 不能授权正式发布。包内原有 `release:prepare` 保留为较底层的资产准备操作，详见该包发布指南。

## 预览桌面源码

桌面端已有两个启动命令，不需要每次源码修改都制作安装器：

```sh
pnpm run dev:desktop
pnpm run start:desktop
```

`dev:desktop` 构建当前应用产物与 Electron 壳后启动；`start:desktop` 直接使用已有产物，跳过构建，应在完成对应模块构建后使用，不能代替源码构建。已有完整构建时，仅修改视觉策展可先运行 `pnpm run build:visual-curator`，再运行 `pnpm run start:desktop`；应用范围的修改使用 `dev:desktop`。隔离目录、环境覆盖、首次运行时准备与调试端口见[桌面开发](../../../apps/desktop/README.zh.md#develop)。

开发 profile 和浏览器数据默认与正常桌面安装分开。日常开发不要把 `DSH_HOME` 指向生产 home。显式安装的同名包可能优先于工作区依赖，应先确认安装来源和版本，再判断修改是否加载。开发菜单中的刷新和重启都不会重新构建源码；Host 模块修改后需重启 Host，仅在验证无需 Host 重载的已构建 Client 内容时使用页面刷新。

## 验收一次本地测试

生成可安装包不等于功能已验收。记录包名、本地版本、SHA256、正在运行的应用版本和安装重启结果，再操作修改的功能。视觉策展应检查分析完成后数据集无需手动刷新即可出现、已打开找图表单同步更新数据集选项、分析信息默认隐藏且能折叠展开、可恢复失败提供继续分析。验收模型输出质量时，使用预期的实际提供方测试。

本地包、桌面源码预览和正式远程更新覆盖不同路径。构建记录区分快速与完整插件检查；两种模式均不代表已经执行桌面安装、付费模型请求或远程更新验收。

## Dev Note

以下是待实施的桌面交互方案，不描述已经存在的控件。本次交付命令与测试规范，不添加导入按钮或本地构建标签。

- 在通用插件管理安装区增加“导入本地包”，在已安装 bundle 的版本更新面板增加“从本地更新”。两者进入同一条流程，适用于所有 `dsh.bundle` 包，通过原生文件选择器选择 `.tgz` 或 `.tar.gz`。
- 安装前在隔离目录检查包，展示包名、已安装版本与候选版本、本地构建状态、SHA256、兼容性和重启要求。详情页导入须与当前插件包名一致。复用现有更新事务的配置备份、功能选择、替换、失败恢复和延后生效；单独使用普通安装表单不提供这套预览及事务。
- 由统一的 `-local` 版本约定显示“本地构建”，同时保留基线与完整安装版本；不要把本地传递路径等同于本地构建，下载到磁盘的原样正式包仍属于正式版本。安装稳定正式清单后自然移除本地标签，不额外持久化一份版本标记。
- 保留已声明的正式更新源。在导入确认页提供并预选“测试期间暂停自动安装”，继续允许检查更新；同基线正式版显示“切回正式版”，更高版本显示“更新正式版”。就地展示进度和失败，替换成功后才结束本地状态，由用户重新开启自动安装。
- 通用入口验收覆盖替换、重启、功能配置保留、不兼容或错误包拒绝、中断恢复，以及后续正式更新。未声明远程更新源的包可以导入，但文件路径本身不能为它补出远程来源。
