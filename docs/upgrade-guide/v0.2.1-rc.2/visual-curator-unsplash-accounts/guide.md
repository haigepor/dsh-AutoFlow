---
kind: upgrade-guide
description: Visual Curator source settings add an Unsplash provider and independent account credential references.
---

# Visual Curator Unsplash accounts

English | [中文](guide.zh.md)

## Change

The optional Visual Curator bundle adds `source.provider` and `source.unsplash` to its validated configuration. Existing JSON sources resolve to `generic` and retain their mappings. The Model & gallery settings page can save multiple website sessions through DSH credentials and browse their collections. The `unsplash` source ID searches the full library with the explicitly selected account, or publicly when `defaultAccountId` is `null`.

Account session values do not belong in configuration or task JSON. Older builds reject the new settings fields when loading a profile saved by this build.

## Migration

1. Existing JSON-source configurations need no edit. For Unsplash, use Add account in Model & gallery settings, then sign in in the separate official-site window; the verified account connects automatically. Advanced settings opens the original JSON provider in a modal.
2. Set `source.provider: unsplash` and select `source.unsplash.defaultAccountId`, or use the page's default-source action. Source consumers pass `sourceId: unsplash`; the eight existing Agent tools and fixed-style inputs remain available.
3. Keep `source.unsplash.accounts` descriptors separate from the credential values they reference. Ensure system curl and Chrome or Edge are available. `source.unsplash.curlBinary` selects curl; `source.unsplash.login.browser` selects `auto`, `msedge` or `chrome`, and `login.executablePath` can select another installed executable. The Host needs a graphical session. Sign-in uses a temporary browser profile; no personal browser profile is read or copied. Do not copy an account Cookie file into a distributed plugin package.
4. Before downgrading, back up the profile configuration and credentials, select the generic source, and remove `source.provider` and `source.unsplash` from the saved provider configuration. Confirm that the previous source endpoint and credential reference remain correct before starting the older build.
