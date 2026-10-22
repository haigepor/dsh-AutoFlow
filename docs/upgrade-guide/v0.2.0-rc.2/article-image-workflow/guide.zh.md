---
kind: upgrade-guide
description: "文章生图组合包和工具包已移除；现有 profile 须移除对应的组合包声明和补丁行。"
---

# 从现有 profile 移除文章生图插件

[English](guide.md) | 中文

## 变更

应用不再附带 `dsh-plugin-article-image` 或 `article-image-toolkit`。新建 Web 和 Desktop profile 不再包含该组合包。文章工作台、文章工具、内置编辑配图 Skills、采集队列和配图规划不再可用。现有 profile 文件由用户管理，须按下列步骤清理。

## 迁移

1. 停止受影响的 Host，编辑配置前保留其 profile 文件和文章数据。
2. 在 `$DSH_HOME/profiles/<profile>/package.json` 中，从 `dsh.profile.bundles` 移除 `dsh-plugin-article-image`；若 `dependencies` 中也有该项，一并移除。若曾独立安装且不再使用 `article-image-toolkit`，也移除该依赖。
3. 从 profile、Home 和命令行覆盖配置中移除 id 为 `article-image`、`article-image-tools`、`article-image-ui`、`article-image-ui-settings`、`article-image-ui-conversation` 和 `article-image-skills` 的补丁行。若客户端配置了独立 toolkit MCP 启动项，也将其移除。
4. 重启 profile，确认启动时没有插件缺失或补丁行缺失错误，且不再提供文章工作台和文章工具。
5. `$DSH_HOME/.plugins/dsh-plugin-article-image/profiles/` 下的文章数据仍保留在磁盘。独立 toolkit 数据默认位于 `.article-image`，可由 `--data-dir` 或 `ARTICLE_IMAGE_DATA_DIR` 覆盖。移除应用代码不会删除这些记录；如需保留，请复制完整目录。删除这些目录会永久丢弃其中的文章、原图和方案。历史 Session 日志仍由 Session 系统管理。
