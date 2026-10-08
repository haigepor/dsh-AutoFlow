# AFP 版本发布

[English](README.md) | 中文

## Summary

从本仓库向 GitHub Releases 发布独立 AFP 包。包版本决定 `afp-v<version>` 标签；AFP 不与应用共用发布版本或 latest 标记。[release.config.json](../release.config.json) 负责维护仓库、标签前缀与稳定频道。完整执行和验证流程使用[发布 Skill](../../../../.agents/skills/dsh-custom-plugin-release/SKILL.md)。

## 准备源码

使用仓库要求的 Node.js 和 pnpm 版本、Git，以及具备目标仓库写权限的 GitHub CLI。阅读 [UPSTREAM.md](../UPSTREAM.md) 并保留来源记录；本流程不向 npm 发布，也不为适配的第三方代码推定许可证。审核待发布改动，为新版本更新 `package.json`，同步 README 双语对，并在准备正式资产前提交。不得覆盖已发布版本或移动其标签。

在仓库根目录准备已提交版本：

```sh
pnpm --filter dsh-plugin-afp run release:prepare --out .artifacts/afp-release
```

该命令运行 AFP 测试，通过 `prepack` 构建和检查包，验证 tarball 路径及声明入口，生成三个资产：`dsh-plugin-afp-<version>.tgz`、`SHA256SUMS` 和 `afp-update.json`。JSON 记录精确源码提交、标签、下载地址、SHA-256 与字节数。`--tag afp-v<version>` 校验指定标签。`--allow-dirty` 仅用于本地演练：元数据会标记脏树，发布器拒绝此类产物。

## 发布与验证

将审核后的源码和新 `afp-v<version>` 标签推送到配置的仓库。[AFP 工作流](../../../../.github/workflows/release-afp.yml) 从标签构建，校验包版本和源码提交，在无写入凭据的阶段准备产物，再由独立发布任务上传草稿。资产校验通过后才公开发布，并设置 `latest=false`。手动触发工作流同样要求 AFP 标签。已有 Release 会阻止发布，不会替换其资产。

工作流成功后，检查 Release、上传的三个资产和标签提交。将 `.tgz`、`SHA256SUMS` 与 `afp-update.json` 下载到新目录，重新计算 SHA-256，并核对元数据中的版本、源码提交与大小。通过支持的 `dsh` 启动器，在临时 DSH profile 中测试下载的包，检查 Host 入口、bundle 功能、Client 资源和配置保留。不要仅为验证 tarball 而覆盖现有内置 AFP。

## 更新与恢复

这些资产提供有版本的 GitHub 分发渠道。当前插件页面不会查询该渠道或自动安装更新。根目录的 `pnpm install` 使用工作区与 lockfile；更新仓库并构建后才会更新内置 AFP。后续运行时更新需要让 bundle 元数据、patch、Host、Client 和资源共用同一版本选择，并使用用户所属的安装目录和配置迁移。

发布失败的草稿可在核对标签与已上传字节后检查和恢复；不得静默覆盖资产或删除无关 Release。已公开版本的问题通过新包版本和标签修正。保留旧 tarball，以及用户的功能选择、凭据和报告；包降级无法撤销不可逆的数据迁移。

## Dev Note

无。
