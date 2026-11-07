# Visual Curator device handoff

English | [中文](visual-curator-2026-11-07.zh.md)

This handoff records the Visual Curator work checked on 2026-11-07 and provides a prompt for another device. It is an engineering checkpoint, not a release announcement. Repository state and new verification take precedence over these recorded observations.

## Contents

- [Source and launch](#handoff-source)
- [Implemented behavior](#handoff-behavior)
- [Verification and limits](#handoff-verification)
- [Local data transfer](#handoff-data)
- [Continuation prompt](#handoff-prompt)

<a id="handoff-source"></a>

## Source and launch

The repository is `https://github.com/haigepor/dsh-AutoFlow.git`, branch `main`. The current branch contains the storage, conversation, Desktop and curator changes. Read the current log before continuing. No version tag, release publication or update-feed publication is part of this handoff.

The repository declares Node >=24.9.0 and pnpm 11.28.5. On a new device, install the declared dependencies and start through the supported `pnpm run dev:desktop` command. After artifacts are already built, `pnpm run start:desktop` skips that build. Source development and installed custom-plugin bundles are separate: verify which plugin version Desktop actually loads before testing a change.

The Windows verification used `D:\project\deepseek-harness`. Desktop has the locally installed Visual Curator version `0.2.14-local.20261107084656.570`, which is a private test build rather than a published version. A new checkout must rebuild and install its own local bundle with `node custom-plugins/release-governance/plugin-workflow.mjs dsh-plugin-visual-curator --local` when testing the installed-plugin path.

<a id="handoff-behavior"></a>

## Implemented behavior

Storage supports selective loading and releasing of manual-table records. Visual Curator reuses current manifest records instead of hydrating every historical physical record, and shared image requests use bounded saved previews. Attachment previews, Session media references and normal Markdown image rendering retain their original resources for explicit opening.

Native search launches retain normal assistant text and use persisted display-only task checkpoints for progress. Workspace and source validation, continuation recovery, cancellation, task ownership and plugin reload have corresponding changes. Authorized Codex image requests no longer require the text extra-credit switch to be enabled.

The image workflow reuses six batch-owned nodes: original and storage → subject and safe-area planning → crop and size planning → crop and extension when needed → quality review → final and export. Switching images updates content and status while retaining positions, dimensions, folds and the camera. Previous image-specific layouts remain stored separately.

The resizable image sidebar remembers its width, shows at most twelve thumbnails per group, allows the last thumbnail to scroll fully into view and has no green thumbnail dots. Its opaque image menu uses readable rows. Narrow windows use horizontal navigation. Content fades in for 160ms, with reduced motion respected. Cancelled or mismatched image responses cannot expose another image's editor or result.

The backend work covers subject evidence and safe-area geometry, search query planning and pagination, crop validation, mask and returned-size handling, original-pixel composition and independent result review. Reuse saved results first; an added presentation node does not imply another model call. Never lower acceptance rules to make a result pass.

<a id="handoff-verification"></a>

## Verification and limits

Additional pre-push runs passed the affected startup/storage files (217 tests), preview/Markdown/Host files (55 tests), and Codex account file (47 tests). One platform-specific case was skipped in the broader initial selection. The first combined startup run exceeded the default five-second deadline under competing checks; the complete startup file then passed without increasing that deadline.

The latest source passed `pnpm run build:artifacts` (14 checks), followed by `pnpm run build:check` (2 checks), and the plugin's host/client/tests compiler faces. The earlier complete curator test run passed 900 tests; later UI changes passed their 30 focused tests, followed by 11 layout/navigation tests after adding the resize-order regression. These are separate runs, not one combined full-suite run of the final source.

Real Desktop verification used existing one-image and twenty-image tasks. Switching images 8 → 20 → 3 → 8 retained node DOM, positions, camera and folds. Image 8 opened its own saved plan with scale 0.568, offset -218/-681 and eight protected regions; its review showed 7/7 and export referenced its saved final image. Existing native assistant prose remained visible. The installed task state was byte-for-byte equal as serialized before and after installation: 20/20 passed, same Run and saved attempts.

A separate fixture used the production React Flow and native UI with 100 synthetic image records. Seven image changes added zero node DOM instances and read one complete image at a time. Sidebar resizing, width restoration, last-thumbnail scrolling, light theme, 640×850 layout and reduced motion were checked. This fixture does not establish real provider search accuracy, batch image-generation throughput or multi-session quality.

The final layout validation did not rerun search, crop or generation. Broader real search, crop and extension work predates it. Reassess current credentials, quota and provider behavior before another paid operation; the extra-credit switch remains separate from image entitlement.

Useful retained task identifiers are source Run `529370df73b23b6ec0b081a192d3a14300275cb7326793277f2e7925c462a327`, wallpaper Run `22e7a8181c3284c97fa5791fc3a791b2dd7c3acf3edc4ecc1c0bfb9cb1b40f08`, batch `14e334d3-d147-4537-8c07-2277922d8e9f`, Session `1b81b9a7-8eda-4666-a500-67aa995e646c` and image 8 `761646ff-7a47-46e9-bbf9-99c9612a151f`. They are available only if the corresponding profile data is transferred.

<a id="handoff-data"></a>

## Local data transfer

Git transfers source, tests and this handoff. It does not transfer `.artifacts`, local plugin archives, reference images, generated images, Session histories, local profiles or account credentials. The local verification notes live under `.artifacts/visual-curator-fixed-flow-20261107/RESULTS.zh.md`; copy selected evidence separately if it is needed.

The source-launched Windows Desktop used `apps/desktop/.desktop-build/development/home` for its application data and `apps/desktop/.desktop-build/development/electron-user-data` for renderer-local preferences. Close Desktop before making a consistent backup of both. Transfer a backup to an isolated location on the new device before restoring; do not overwrite newer target-device history. The desktop profile contains the curator storage and image files. Prefer preserving the complete application-data directory rather than copying only one database or image folder.

Workspace paths and account authorization may differ on the new device. Select an existing local Workspace and reauthorize providers as needed. Do not commit profile data or credentials, edit Session JSONL/SQLite to repair history, or assume that a local test archive is downloadable from GitHub.

<a id="handoff-prompt"></a>

## Continuation prompt

The following Chinese prompt is ready to paste into a new device's independent session after the repository is available there.

```text
继续维护 AutoFlow / deepseek-harness 的 Visual Curator 插件。先读取仓库 AGENTS.md、docs/handoffs/visual-curator-2026-11-07.zh.md 和最新 git log/status，以实际代码为准，不假定新设备已有旧设备的 .artifacts、插件安装包、历史数据或账号授权。

仓库 https://github.com/haigepor/dsh-AutoFlow.git，分支 main。核心目录 custom-plugins/workspace/dsh-plugin-visual-curator；相关修改还涉及存储选择性加载、Session task journal、附件预览、Desktop 插件重载与 Codex 生图额度判断。

当前画布采用批次总览与固定单图流程两层。固定六步：原图与保存 → 主体与安全区规划 → 裁剪与尺寸规划 → 裁剪与必要扩图 → 质量复审 → 成品与导出。切图只更新节点内容和状态，保持位置、宽高、折叠和视角；侧栏可拖宽并记忆、分页缩略图、底部完整滚动，无绿色缩略图圆点；切图有内容淡入并遵循减少动态效果。不要重新改成每张图重建整张画布。

保留现有 UI 风格、历史数据、原图及正常 AI 对话，不放宽主体保真和安全区质量门槛。优先复用已有分析与生成结果；裁剪能满足尺寸时不扩图，确实缺失背景才扩图。Codex 已授权的生图额度不应强制依赖“允许使用额外积分”。真实生图前核对当前额度和本次授权，不自动重试未知结果的付费请求。

先确认 Node >=24.9.0、pnpm 11.28.5、依赖、工作区和插件实际加载版本。用 pnpm run dev:desktop 启动；已构建时可用 pnpm run start:desktop。需要安装插件时运行 node custom-plugins/release-governance/plugin-workflow.mjs dsh-plugin-visual-curator --local，通过当前 Desktop 插件管理器安装该次生成的包并重启，不使用旧设备路径硬套。

检查是否已经迁移旧设备的开发 application data 和 electron-user-data。Git 本身不包含素材、生成图、会话、账号或本机布局。没有旧数据时先明确这个限制，再用隔离数据验证，不伪造“已验证历史任务”。不要覆盖新设备已有数据，不修改 Session JSONL/SQLite，不把授权凭据写入 Git。

已完成的证据包括：旧设备真实单图与 20 张任务、正常 assistant 正文、7/7 复审与正确成品链接；100 张为真实 React Flow 配合隔离数据的布局/切换验证，不代表 100 张真实生图。旧设备安装版本为 0.2.14-local.20261107084656.570，仅本地测试，未发布。

后续先建立新设备运行基线，再按实际问题继续检查远程收藏夹导入、多批次画像归纳与数据集表达、分页找图与视觉校验、安全区/水平竖直参考线、自动与手动裁剪、必要扩图的接缝/尺寸/原图合成、独立复审及多会话性能。先跑一张，再按需要扩大到 10/20 张；发现可复现问题直接修复，并用聚焦测试与实际界面验证。不要把历史需求当作每次必须重新运行的完整付费任务清单。暂不发布版本、创建版本标签或推送更新源；新的提交推送按当前用户要求执行。
```
