# AutoFlow

[English](README.md) | 中文

## 概述

AutoFlow 是基于 DeepSeek Harness 的 AI（人工智能）agent（智能体）工作台，支持模型配置、插件流程与自定义界面。你可以围绕本地项目执行任务，并通过 AFP 扩展图片检索与视觉筛选。AutoFlow 定制包含在本仓库源码中；官方 npm 包运行的是上游 DeepSeek Harness。上游框架仍处于开发者预览阶段，执行任务前请阅读[安全说明](SAFETY.zh.md)。

## 目录

- [项目特色](#features)
- [安装与启动](#run)
- [第一次使用](#first-session)
- [更新已有检出目录](#update)
- [常见问题](#troubleshooting)
- [开发与支持](#development-and-support)
- [上游与许可证](#upstream-and-license)

-----

<a id="features"></a>
## 项目特色

AutoFlow 保留 DeepSeek Harness 的插件架构，并提供适合日常使用的可配置工作台。

| 特色 | 可以做什么 |
| --- | --- |
| 模型配置 | 配置模型提供商和 OpenAI 兼容端点，再为任务选择模型。 |
| 自定义外观 | 选择官方或当前项目配色、亮色/暗色/跟随系统、字体、圆角和文字大小。 |
| 插件流程 | 通过插件管理器为当前 profile 启用需要的工具与 skill（技能）。 |
| AFP 图片工作流 | 检索图片、运行可续跑的视觉筛选，预览私有收藏夹变更后再确认远端写入。 |
| Web 与 Desktop 入口 | 从源码启动 Web UI；桌面开发与打包方式见开发指南。 |

AFP 需要单独配置账户凭据；视觉筛选还需要配置视觉模型。操作方式、权限与限制见 [AFP 组合包指南](custom-plugins/workspace/dsh-plugin-afp/README.zh.md)。

-----

<a id="run"></a>
## 安装与启动

运行 AutoFlow 请使用源码入口。`afp-v*` Release 资源是 AFP 插件包，不是 AutoFlow 应用安装包。

### 环境要求

| 工具 | 要求 |
| --- | --- |
| Node.js | `^22.19.0 || >=24.0.0` |
| pnpm | `11.28.5`，以 `package.json` 的 `packageManager` 为准 |
| Git | 用于克隆和更新本仓库 |
| 模型访问 | 受支持的模型提供商或兼容端点的凭据 |

安装前检查 `node --version` 和 `pnpm --version`。原生构建及平台要求由[开发指南](docs/development.zh.md)维护。

<a id="run-from-source"></a>
### 从源码运行 AutoFlow

克隆本仓库的 `main` 分支，并从仓库根目录执行：

```sh
git clone --branch main https://github.com/haigepor/dsh-AutoFlow.git
cd dsh-AutoFlow
pnpm install --frozen-lockfile
pnpm run web:rebuild
```

Web UI 默认地址为 `http://127.0.0.1:3080`。本机启动时会打开默认浏览器；SSH 启动时打印宿主机 URL。使用期间保留服务终端；修改端口后，以终端打印的地址为准。

`web:rebuild` 先构建仓库，再启动 `dsh web`；构建失败时不会启动。`pnpm run start:web` 与 `pnpm dsh web` 复用已有产物。Git 不包含 `lib/` 或 `apps/web/dist/`，拉取更新后需重新构建。重启前先停止原服务；`pnpm run web:rebuild --no-open --port 3081` 可改用其他端口且不打开浏览器。

<a id="run-from-npm"></a>
### 运行上游 DeepSeek Harness

如需体验官方上游软件包，而非本仓库定制版本，可运行：

```sh
npx @deepseek-ai/dsh web
```

该命令不会安装 AutoFlow 定制内容。上游使用方法见 [Web UI 指南](docs/user/guide/index.zh.md)。

-----

<a id="first-session"></a>
## 第一次使用

服务运行后，先配置模型和工作区，再发送任务。

1. 打开“设置 → 模型”，配置模型提供商及凭据并保存。兼容端点的配置见[模型指南](docs/user/guide/providers.zh.md)。
2. 通过工作区选择器添加并选中项目目录。选中工作区前，会话输入框不可用。
3. 打开“设置 → 外观主题”，选择当前项目的“鸢尾紫”配色，使用 AutoFlow 自定义颜色。新设备默认使用官方配色。
4. 在插件管理器检查当前 profile。新建 Web/Desktop profile 默认选中 AFP；已有 profile 保留原选择，Headless/SDK 不启用。配置方式见 [AFP 指南](custom-plugins/workspace/dsh-plugin-afp/README.zh.md)。
5. 启动会话，先发送一个小任务，例如“概述这个仓库并指出主要模块”。当前权限策略要求审批时，先检查待执行操作。

外观与插件选择属于每台设备的 DSH Home。克隆或更新源码不会复制另一台设备的设置与凭据。AFP 远端写入仍需写入计划和明确确认。

-----

<a id="update"></a><a id="update-another-device"></a>
## 更新已有检出目录

先保存本地修改。在已有 AutoFlow 检出目录中确认 `origin` 指向本仓库，停止运行中的服务，再更新并重建：

```sh
git remote get-url origin
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run web:rebuild
```

`deepseek-harness` 分支保存官方镜像；`main` 包含 AutoFlow 改动。软件包版本表示官方基线，`autoflow-v*` 标签表示 AutoFlow 里程碑。核对构建来源时，可比较 `git log -1 --oneline` 与 `.dsh-build/client-build-environment.json` 的 `environment.DSH_CLIENT_COMMIT_HASH`。维护时使用[官方更新审查指南](docs/cookbook/maintaining-autoflow-fork.zh.md)。

<a id="troubleshooting"></a>
## 常见问题

根据现象定位需要检查的配置或构建步骤。

| 现象 | 检查方式 |
| --- | --- |
| pnpm 版本不匹配 | 使用 `package.json` 的 `packageManager` 版本，不要通过重建锁文件绕过版本要求。 |
| 缺少产物或仍显示旧界面 | 安装依赖后运行 `pnpm run web:rebuild`；仅启动命令不会重建。 |
| 端口被占用 | 停止旧服务，或使用上文参数选择其他端口。 |
| 会话输入框不可用 | 添加并选中工作区，再确认已经配置模型。 |
| 显示官方配色 | 在“设置 → 外观主题”选择“鸢尾紫”；新设备默认使用官方配色。 |
| AFP 不显示或不可用 | 按 AFP 指南检查当前 profile、功能开关、凭据和模型设置。 |

-----

<a id="development-and-support"></a><a id="development"></a><a id="community-and-support"></a><a id="contributing"></a>
## 开发与支持

[开发指南](docs/development.zh.md)维护平台环境、构建命令、Web/Desktop 开发与打包方式；[架构文档](docs/architecture.zh.md)介绍插件模型。`pnpm run dev:web` 完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出对应 Make target。

- AutoFlow 定制问题提交到[本仓库 Issues](https://github.com/haigepor/dsh-AutoFlow/issues)。
- DeepSeek Harness 上游问题通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 讨论。
- 插件仓库可添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题；也可加入上游 [Discord 社区](https://discord.gg/4MrtZUhpxg)。
- 中文社区入口包括上游[企微群问卷](https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg)与[微信公众号二维码](https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png)。
- 贡献前阅读 [CONTRIBUTING.md](CONTRIBUTING.zh.md)；agent 遵循 [AGENTS.md](AGENTS.md)。

<a id="upstream-and-license"></a>
## 上游与许可证

AutoFlow 基于 DeepSeek Harness（`dsh`），它是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。其一切皆插件架构由 [Cordis](https://github.com/cordiverse/cordis) 驱动，设计参见 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。上游文档见 [DeepSeek Harness 文档站](https://deepseek-harness.github.io/deepseek-harness/)。

<a id="developer-preview"></a>

DeepSeek Harness 仍处于开发者预览阶段，可能出现破坏兼容性的变更。使用前请阅读[安全说明](SAFETY.zh.md)。

### 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

<a id="license"></a>

[MIT](LICENSE)。第三方依赖与许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>非权威工作备注</summary>

无。

</details>
