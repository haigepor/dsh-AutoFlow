# AutoFlow

[English](README.md) | 中文

AutoFlow 基于 DeepSeek Harness，提供自定义模型配置、插件流程和界面样式。DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

此入口运行官方 DeepSeek Harness 软件包。测试 AutoFlow 请使用下方的源码入口。安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

使用 Node.js `^22.19.0 || >=24.0.0` 和 pnpm `11.7.0`，克隆本仓库的 `main` 分支：

```sh
git clone --branch main https://github.com/haigepor/dsh-AutoFlow.git
cd dsh-AutoFlow
pnpm install --frozen-lockfile
pnpm run web:rebuild
```

`pnpm run web:rebuild` 完整构建仓库后启动 `dsh web`；构建失败时不会启动。`pnpm dsh web` 与 `pnpm run start:web` 复用已有产物。Git 不包含 `lib/` 和 `apps/web/dist/`，拉取更新后需要重新构建。重启前先停止原服务；`pnpm run web:rebuild --no-open --port 3081` 可使用另一个端口。

### 更新其他设备

在已有 AutoFlow 检出目录中，确认 `origin` 是 `https://github.com/haigepor/dsh-AutoFlow.git`，再更新并重建：

```sh
git remote get-url origin
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run web:rebuild
```

`deepseek-harness` 分支保存官方镜像；`main` 包含 AutoFlow 改动。对照 `git log -1 --oneline` 与 `.dsh-build/client-build-environment.json` 中的 `environment.DSH_CLIENT_COMMIT_HASH`，确认构建对应的源码提交。软件包版本表示官方基线，`autoflow-v*` 标签表示 AutoFlow 版本里程碑。协调官方更新与 AutoFlow 定制时，使用[官方更新审查指南](docs/cookbook/maintaining-autoflow-fork.zh.md)。

外观选择与已安装插件属于每台设备的 DSH Home。新设备默认使用官方配色；在“设置 → 外观”中选择“当前项目”即可使用自定义配色。每台设备都需要将 [AFP 组合包](custom-plugins/workspace/dsh-plugin-afp/README.zh.md)安装到当前 profile；克隆插件源码不会自动启用插件。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
