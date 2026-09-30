# AutoFlow

English | [中文](README.zh.md)

AutoFlow extends DeepSeek Harness with custom model configuration, plugin workflows, and interface styling. DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

This runs the official DeepSeek Harness package. To test AutoFlow, use the source instructions below. Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

Use Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0`. Clone this repository's `main` branch:

```sh
git clone --branch main https://github.com/haigepor/dsh-AutoFlow.git
cd dsh-AutoFlow
pnpm install --frozen-lockfile
pnpm run web:rebuild
```

`pnpm run web:rebuild` completes the repository build before starting `dsh web`; a failed build prevents startup. `pnpm dsh web` and `pnpm run start:web` reuse the existing artifacts. Git does not carry `lib/` or `apps/web/dist/`, so rebuilding is required after pulling updates. Stop the previous server before restarting; `pnpm run web:rebuild --no-open --port 3081` selects another port.

### Update another device

In an existing AutoFlow checkout, confirm that `origin` is `https://github.com/haigepor/dsh-AutoFlow.git`, then update and rebuild:

```sh
git remote get-url origin
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run web:rebuild
```

The `deepseek-harness` branch mirrors upstream; `main` contains AutoFlow changes. Compare `git log -1 --oneline` with `environment.DSH_CLIENT_COMMIT_HASH` in `.dsh-build/client-build-environment.json` to confirm the built source commit. The package version identifies the upstream baseline; `autoflow-v*` tags identify AutoFlow milestones.

Appearance choices and installed plugins belong to each device's DSH Home. A new device starts with the official palette; select “Current project” under Settings → Appearance to use the custom palette. Install the [AFP bundle](custom-plugins/workspace/dsh-plugin-afp/README.md) into the active profile on each device; cloning its source does not activate it.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
