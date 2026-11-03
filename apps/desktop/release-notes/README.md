# Desktop release notes

English | [中文](README.zh.md)

Desktop update dialogs, official update feeds and GitHub Releases use one reviewed version manifest. Notes describe user-visible behavior, including changes in plugins shipped with Desktop; implementation logs, test counts and speculative speed claims stay out of the product copy.

## Accumulate changes

Add one UTF-8 JSON file to `changes/` while implementing a desktop-visible change. Use a stable `id`, a category (`features`, `improvements`, `fixes`, `other`) and concise `text.en` and `text.zh-CN` strings. State the trigger and resulting behavior; combine repeated fixes for the same problem before release. Keep completed user-visible work only. Leave unchanged fragments in place after release; manifests record which IDs have been included.

```json
{
  "id": "plugin-download-idle-timeout",
  "category": "fixes",
  "text": {
    "en": "Plugin downloads can continue while data is arriving instead of timing out after a fixed total duration.",
    "zh-CN": "修复插件安装包持续下载时仍因固定总时限而超时的问题。"
  }
}
```

## Prepare a version

Choose the exact build version, then run from the repository root:

```sh
node --import tsx/esm apps/desktop/scripts/release-notes.ts <exact-build-version>
```

The command collects IDs absent from previous manifests and exclusively creates `releases/<version>.json`. It retains fragments and refuses empty releases, duplicate IDs, missing translations, placeholder text and existing version files. Review wording and scope, combine related items, remove internal work and known-unfinished features, and commit the manifest with the source before packaging. Never edit an already published version's manifest; corrections belong to a new version and a new item ID. A change deliberately repeated in a later stable release is added during review of that version's manifest, rather than duplicating its daily fragment.

## Publication and presentation

Publication reads the manifest with `git show <build-commit>:apps/desktop/release-notes/releases/<version>.json`. Uncommitted notes or notes from a later checkout cannot describe an older build. Missing, malformed or version-mismatched notes reject preparation before uploads. Structured `dshReleaseNotes`, standard `releaseNotes` and the bilingual Release body come from these same items; official metadata stays on the configured official feed.

The dialog renders plain text in four groups below download controls, omits empty groups and scrolls long content independently. Chinese uses Chinese content; other interface languages use English content with localized headings and controls. Progress updates retain the notes' scroll position. Older feeds display a localized unavailable message; invalid optional notes do not prevent downloading a verified installer. Download completion still requires separate installation confirmation.
