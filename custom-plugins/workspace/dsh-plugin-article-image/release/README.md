# Article images releases

English | [中文](README.zh.md)

## Preparation

The package version owns `article-image-v<version>` tags. From reviewed, committed source, run `pnpm --filter dsh-plugin-article-image release:prepare --out .artifacts/article-image-release`. Preparation runs tests, builds the Client through prepack, verifies packed entries, and creates `dsh-plugin-article-image-<version>.tgz`, `SHA256SUMS` and `article-image-update.json`. Metadata records the exact source commit, tag, size and SHA-256. `--allow-dirty` creates rehearsal assets marked sourceDirty; the updater refuses them. No tags, pushes or GitHub Releases are created by this command.

## Publication and updates

Publish reviewed clean-source assets under their exact new tag through a draft GitHub Release, verify all three assets before public visibility, and set `latest=false`. Never reuse a public version or overwrite its assets. The package's update declaration points the existing bundle updater at this tag family and metadata filename. Installation takes effect after restart and preserves configuration and local records. Source preparation does not establish that a remote release or update installation has been verified. Follow the shared [release governance](../../../release-governance/README.md).
