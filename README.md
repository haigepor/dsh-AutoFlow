# AutoFlow

English | [中文](README.zh.md)

## Summary

AutoFlow is an AI agent workspace based on DeepSeek Harness, with configurable models, plugin workflows, and a customized interface. Use it to work with a local project and extend the workspace with AFP image search and visual review. The source checkout contains AutoFlow customizations; the official npm package runs upstream DeepSeek Harness. The upstream harness remains in developer preview, so review the [safety notice](SAFETY.md) before running tasks.

## Table of Contents

- [What makes AutoFlow different](#features)
- [Install and run](#run)
- [First session](#first-session)
- [Update an existing checkout](#update)
- [Troubleshooting](#troubleshooting)
- [Development and support](#development-and-support)
- [Upstream and license](#upstream-and-license)

-----

<a id="features"></a>
## What makes AutoFlow different

AutoFlow keeps the plugin architecture of DeepSeek Harness and adds a configurable workspace for daily use.

| Feature | What you can do |
| --- | --- |
| Model configuration | Configure model providers and OpenAI-compatible endpoints, then select a model for your task. |
| Custom appearance | Choose the official or current-project palette, light/dark/system mode, fonts, corner radius, and text sizes. |
| Plugin workflows | Enable the tools and skills needed by the active profile through the plugin manager. |
| AFP image workflow | Search images, run resumable visual review, and preview private-collection changes before confirming remote writes. |
| Web and Desktop entry points | Start the Web UI from source; desktop development and packaging are documented in the development guide. |

AFP requires its own account credentials and a configured visual model for visual review. Its operations, permissions, and limits are documented in the [AFP bundle guide](custom-plugins/workspace/dsh-plugin-afp/README.md).

-----

<a id="run"></a>
## Install and run

Use the source checkout to run AutoFlow. The `afp-v*` Release assets are AFP plugin packages, not AutoFlow application installers.

### Prerequisites

| Tool | Requirement |
| --- | --- |
| Node.js | `^22.19.0 || >=24.0.0` |
| pnpm | `11.28.5`, as declared by `packageManager` in `package.json` |
| Git | Required to clone and update this repository |
| Model access | Credentials for a supported model provider or a compatible endpoint |

Check `node --version` and `pnpm --version` before installing. Native build and platform requirements are maintained in the [development guide](docs/development.md).

<a id="run-from-source"></a>
### Run AutoFlow from source

Clone this repository's `main` branch and run the following commands from its root:

```sh
git clone --branch main https://github.com/haigepor/dsh-AutoFlow.git
cd dsh-AutoFlow
pnpm install --frozen-lockfile
pnpm run web:rebuild
```

The Web UI uses `http://127.0.0.1:3080` by default. A local launch opens the default browser; an SSH launch prints the host URL. Keep the server terminal running while using the UI, and follow the printed address if you override the port.

`web:rebuild` builds the repository before starting `dsh web`; a failed build prevents startup. `pnpm run start:web` and `pnpm dsh web` reuse existing artifacts. Git does not contain `lib/` or `apps/web/dist/`, so rebuild after pulling updates. Stop the previous server before restarting; `pnpm run web:rebuild --no-open --port 3081` selects another port without opening a browser.

<a id="run-from-npm"></a>
### Run upstream DeepSeek Harness

To try the official upstream package instead of this checkout, run:

```sh
npx @deepseek-ai/dsh web
```

This command does not install AutoFlow customizations. See the [Web UI guide](docs/user/guide/index.md) for upstream usage.

-----

<a id="first-session"></a>
## First session

Once the server is running, configure the model and workspace before sending a task.

1. Open Settings → Models, configure a provider and credentials, and save. See the [model configuration guide](docs/user/guide/providers.md) for compatible endpoints.
2. Add and select a project through the workspace picker. The conversation input stays unavailable until a workspace is selected.
3. Open Settings → Appearance theme and select the current-project palette, Iris, if you want AutoFlow's custom colors. New devices use the official palette by default.
4. Check the active profile in the plugin manager. New Web/Desktop profiles select AFP by default; existing profile selections are preserved, and Headless/SDK do not enable it. Follow the [AFP guide](custom-plugins/workspace/dsh-plugin-afp/README.md) to configure it.
5. Start a conversation with a small task, such as “Summarize this repository and identify its main packages.” Review any approval requested by the current permission policy.

Appearance and plugin choices belong to each device's DSH Home. Cloning or updating source does not copy another device's settings or credentials. AFP remote writes still require a write plan and explicit confirmation.

-----

<a id="update"></a><a id="update-another-device"></a>
## Update an existing checkout

Preserve local changes first. In an existing AutoFlow checkout, confirm that `origin` points to this repository, stop the running server, then update and rebuild:

```sh
git remote get-url origin
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run web:rebuild
```

The `deepseek-harness` branch mirrors upstream; `main` contains AutoFlow changes. The package version identifies the upstream baseline; `autoflow-v*` tags identify AutoFlow milestones. Compare `git log -1 --oneline` with `environment.DSH_CLIENT_COMMIT_HASH` in `.dsh-build/client-build-environment.json` when checking the built source. For maintenance, follow the [upstream-update review guide](docs/cookbook/maintaining-autoflow-fork.md).

<a id="troubleshooting"></a>
## Troubleshooting

Use the symptom to locate the configuration or build step that needs attention.

| Symptom | Check |
| --- | --- |
| pnpm version mismatch | Match `packageManager` in `package.json`; do not regenerate the lockfile to work around the mismatch. |
| Missing or outdated build output | Run `pnpm run web:rebuild` after installing dependencies; the start-only commands do not rebuild. |
| Port already in use | Stop the old server or select a different port with the option shown above. |
| Conversation input unavailable | Add and select a workspace, then confirm a model is configured. |
| Official colors appear | Choose Iris under Settings → Appearance theme; new devices default to the official palette. |
| AFP is missing or unavailable | Check the active profile, enabled features, credentials, and model settings in the AFP guide. |

-----

<a id="development-and-support"></a><a id="development"></a><a id="community-and-support"></a><a id="contributing"></a>
## Development and support

The [development guide](docs/development.md) owns platform setup, build commands, Web/Desktop development, and packaging. The [architecture guide](docs/architecture.md) explains the plugin model. `pnpm run dev:web` builds, serves, and rebuilds client bundles on edits; `make help` lists the corresponding Make targets.

- Report AutoFlow-specific issues in [this repository](https://github.com/haigepor/dsh-AutoFlow/issues).
- Discuss upstream DeepSeek Harness through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to plugin repositories; the upstream [Discord community](https://discord.gg/4MrtZUhpxg) is also available.
- The upstream [WeCom community survey](https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg) and [WeChat official-account QR code](https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png) provide Chinese community channels.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing; agents follow [AGENTS.md](AGENTS.md).

<a id="upstream-and-license"></a>
## Upstream and license

AutoFlow is based on DeepSeek Harness (`dsh`), the open-source agent harness developed by [DeepSeek AI](https://deepseek.com). Its everything-is-a-plugin architecture is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512). Upstream documentation is available at the [DeepSeek Harness documentation site](https://deepseek-harness.github.io/deepseek-harness/).

<a id="developer-preview"></a>

DeepSeek Harness remains in developer preview and can introduce compatibility-breaking changes. Review the [safety notice](SAFETY.md) before use.

### Citation

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

[MIT](LICENSE). Third-party dependencies and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Non-authoritative working notes</summary>

None.

</details>
