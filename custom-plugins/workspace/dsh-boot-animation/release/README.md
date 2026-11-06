# Boot Animation releases

English | [中文](README.zh.md)

## Preparation and publication

Release 0.4.7: Support isolated build output for local plugin packaging and desktop integration.

The AutoFlow adaptation retains the upstream BSD 3-Clause [license](../LICENSE), including the bundled-media permission, and publishes an independent `boot-animation-v<version>` family. Its package includes the Host, Client, selected clip, artwork and profile patch. Review and commit the exact source, then run `pnpm --filter dsh-boot-animation run release:prepare --out .artifacts/boot-animation-release`. The shared release workflow checks native platforms and publishes a tarball, SHA-256 list and update metadata with `latest=false`.

## Runtime updates

The plugin page checks the package-owned GitHub source; automatic installation is opt-in. Updated Host and Client modules load after restart while the profile's enablement and settings remain. The early application startup presentation and its packaged video also belong to the Desktop/Web build and require a matching application release when those assets change. A Release does not itself validate updates on older installed applications.
