# 文章生图版本发布

[English](README.md) | 中文

## Preparation

包版本对应 `article-image-v<version>` 标签。在经过审核并提交的源码上运行 `pnpm --filter dsh-plugin-article-image release:prepare --out .artifacts/article-image-release`。准备过程运行测试，通过 prepack 构建 Client，检查包入口，生成 `dsh-plugin-article-image-<version>.tgz`、`SHA256SUMS` 和 `article-image-update.json`。元数据记录精确源码提交、标签、大小及 SHA-256。`--allow-dirty` 生成带 sourceDirty 标记的演练资产，更新器拒绝安装。该命令不会创建标签、推送或 GitHub Release。

## Publication and updates

经过审核的干净源码资产通过精确的新标签上传为 GitHub Release 草稿，公开前核对三项资产，并设置 `latest=false`。不得复用公开版本或覆盖资产。包的更新声明让现有组合包更新器读取本标签族及元数据文件；安装后重启生效，保留配置和本地记录。源码准备不代表已验证远端发布或更新安装。遵循共用[发布规范](../../../release-governance/README.zh.md)。
