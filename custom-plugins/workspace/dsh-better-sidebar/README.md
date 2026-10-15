---
description: "The official Better Sidebar snapshot and its independent AutoFlow updater."
kind: "package-bundle"
---

# dsh-better-sidebar

English | [中文](README.zh.md)

## Summary

This workspace contains the upstream Better Sidebar source snapshot and the independently loaded [updater](updater/README.md). It contributes file editing, Git changes, tasks and side chat through the existing right-sidebar registration API, and owns a bottom workbench. The application supplies authentication for `/sidebar` HTTP and WebSocket requests independently of either bundle.

## Use this package

Run `pnpm run build:sidebar` at the repository root. Web and Desktop ship both packages and enable them for new profiles, like AFP. Existing profiles retain their bundle selections and saved plugin activation settings; enable **dsh-better-sidebar** and **dsh-plugin-better-sidebar-updater** on the Plugins page if needed. Desktop recovery disables both bundles and backs up the profile patch while retaining installed packages. Theme preferences are retained. Disable the sidebar to restore the native file and viewer registrations.

The plugin takes over the native `files` kind and editable text resources. The existing shell, splitter and theme remain owned by AutoFlow. PDF, images, Office and spreadsheet previews continue through the native providers. The bottom workbench is plugin-owned and starts collapsed.

The local bundle applies [file-changes.css](customizations/file-changes.css) through the sidebar's `customCss` setting: compact underline lens tabs and quiet file-operation filters. The local updater Client measures selected buttons so a shared underline and filter background slide over 240ms and match their widths. Resize and count changes realign them; reduced-motion preferences remove transitions. Without the updater Client, ordinary selection transitions remain available. Your saved customCss takes precedence; clear that field to use the upstream appearance. The updater persists the current field into the profile before an active sidebar update. The CSS uses semantic IDs and roles rather than hashed module names; upstream markup changes can still require adaptation.

## Updates and ownership

The updater checks upstream stable GitHub releases and downloads the exact published npm version. The profile receives the new package and retains its activation and patch configuration. Host and Client use the successor together after restart. The installation-owned `updateManager` declaration remains authoritative even when the upstream successor omits this AutoFlow field.

The matching SVG icons use rounded blue forms with mint accents: a split window for the sidebar and circular arrows for its updater. [Plugin-manager artwork ownership](../../../packages/boot/plugin-manager/README.md) retains the application-supplied sidebar icon when an official npm successor is installed.

Runtime updates do not rewrite this workspace or the packaged application. They replace the running sidebar implementation, including any local implementation changes in this snapshot; they do not merge source patches. Application-owned authentication and theme/layout changes remain outside the updated npm package. Review upstream implementation changes before installation when retaining a local sidebar patch is necessary. [Source record](UPSTREAM.md) describes the imported release.

The local settings presentation is supplied by the independent companion Client; see [its settings behavior and update compatibility](updater/README.md).

## Model Experience

The updater contributes no model prompt or tool. Sidebar side chats create independent agents that can call tools and incur model usage. The optional upstream `sidebar_open` tool follows the sidebar's configuration.

## Known Limitations and Deferred Work

The upstream filesystem routes use Host user permissions and can address paths outside the workspace. The imported release has known cross-session draft-guard and native-tab rename/delete reconciliation limitations; direct official upgrades do not promise to preserve local fixes. This integration keeps the upstream implementation separate from the application's authentication policy.

## Dev Note

The source retains its MIT license. Upstream development instructions and repository automation are not imported into AutoFlow.
