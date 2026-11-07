# Visual Curator 新设备交接

[English](visual-curator-2026-11-07.md) | 中文

本交接记录 2026-11-07 已核对的 Visual Curator 工作，并提供新设备可用的提示词。它是工程检查点，不是版本发布公告。仓库实时状态和新验证结果优先于这里的历史观察。

## 目录

- [源码与启动](#handoff-source)
- [已实现行为](#handoff-behavior)
- [验证与限制](#handoff-verification)
- [本地数据迁移](#handoff-data)
- [继续会话提示词](#handoff-prompt)

<a id="handoff-source"></a>

## 源码与启动

仓库为 `https://github.com/haigepor/dsh-AutoFlow.git`，分支 `main`。当前分支包含存储、会话、Desktop 和策展插件改动。继续前先读取当前日志。本次交接不包含版本标签、Release 发布或更新源发布。

仓库声明 Node >=24.9.0、pnpm 11.28.5。新设备安装项目声明的依赖后，通过支持的 `pnpm run dev:desktop` 启动；产物已构建时，`pnpm run start:desktop` 跳过该次构建。源码开发与已安装自定义插件包是两条路径，测试修改前先确认 Desktop 实际加载的插件版本。

Windows 验证目录为 `D:\project\deepseek-harness`。当前 Desktop 本地安装的 Visual Curator 为 `0.2.14-local.20261107084656.570`，是私有测试构建，不是已发布版本。新设备验证安装插件路径时，应使用 `node custom-plugins/release-governance/plugin-workflow.mjs dsh-plugin-visual-curator --local` 在该设备重新生成并安装本地包。

<a id="handoff-behavior"></a>

## 已实现行为

存储支持手动加载表的选择性加载与释放。Visual Curator 复用当前 manifest 记录，避免加载所有历史物理记录，共享图片请求使用有尺寸限制的已保存预览。附件预览、Session 图片引用和普通 Markdown 图片渲染仍保留显式打开原始资源的能力。

原生找图启动保留普通 assistant 正文，使用持久化、仅用于显示的任务检查点承载进度。工作区与来源验证、继续恢复、取消、任务归属和插件重载均有对应改动。Codex 已授权的生图请求不再强制要求开启文字额外积分开关。

单图流程复用六个批次固定节点：原图与保存 → 主体与安全区规划 → 裁剪与尺寸规划 → 裁剪与必要扩图 → 质量复审 → 成品与导出。切图更新内容与状态，保留位置、尺寸、折叠和视角；此前的单图独立布局仍单独保存。

图片侧栏可调宽并记忆，每组最多十二张缩略图，最后一张可完整滚入视野，已删除绿色缩略图圆点。图片菜单使用独立背景和清晰行高，窄窗口改用横向导航。内容采用 160ms 淡入并遵循减少动态效果设置。已取消或与请求不符的图片响应不能显示另一张图的编辑器或结果。

后端工作覆盖主体依据与安全区几何、搜索关键词规划与分页、裁剪验证、蒙版与返回尺寸处理、原图像素合成和独立结果复审。优先复用已有结果，新增展示节点不意味着额外调用模型，不得通过降低验收规则让结果通过。

<a id="handoff-verification"></a>

## 验证与限制

推送前补充验证通过了受影响的启动/存储文件（217 项）、预览/Markdown/Host 文件（55 项）和 Codex 账号文件（47 项）。最初较广的测试选择中有一项按平台条件跳过；首次并行启动测试在其他检查竞争时超过默认五秒，随后完整启动文件通过，没有增大该超时。

最新源码已通过 `pnpm run build:artifacts`（14 项），随后通过 `pnpm run build:check`（2 项），以及插件 host/client/tests 编译面检查。此前插件完整测试为 900 项通过；后续 UI 修改通过 30 项聚焦测试，新增缩放排序回归后重跑 11 项布局与导航测试通过。这些是不同轮次，不能说成最终源码的一次完整全量运行。

真实 Desktop 使用已有单图与二十张任务验证。第 8 → 20 → 3 → 8 张切换保留节点 DOM、位置、视角与折叠。第 8 张打开自身规划，缩放 0.568、偏移 -218/-681、八处保护标注，复审显示 7/7，导出指向已保存成品；原生 assistant 正文正常显示。安装前后的任务 state 序列化内容完全相等，保持同一 Run、20/20 通过及已有版本。

另一套夹具使用生产 React Flow 与原生 UI，配合 100 张合成图片记录。七次切图新增节点 DOM 为零，每次仅读取一张完整图片；侧栏拖宽、宽度恢复、末张滚动、亮色主题、640×850 布局与减少动态效果均已检查。该夹具不能证明真实供应商找图精度、批量生图吞吐或多会话质量。

最后一轮布局验证没有重新找图、裁剪或生图；较早的真实找图、裁剪及扩图工作发生在此前轮次。下一次付费操作前重新核对当前凭据、额度与供应商行为，额外积分开关与生图资格分开判断。

可定位的历史标识为来源 Run `529370df73b23b6ec0b081a192d3a14300275cb7326793277f2e7925c462a327`、壁纸 Run `22e7a8181c3284c97fa5791fc3a791b2dd7c3acf3edc4ecc1c0bfb9cb1b40f08`、批次 `14e334d3-d147-4537-8c07-2277922d8e9f`、Session `1b81b9a7-8eda-4666-a500-67aa995e646c` 和第 8 张 `761646ff-7a47-46e9-bbf9-99c9612a151f`。只有迁移了对应 profile 数据后，新设备才能读取它们。

<a id="handoff-data"></a>

## 本地数据迁移

Git 迁移源码、测试和本交接文件，不迁移 `.artifacts`、本地插件包、参考图、生成图、Session 历史、本地 profile 或账号凭据。原设备的本地验证记录位于 `.artifacts/visual-curator-fixed-flow-20261107/RESULTS.zh.md`，需要证据时单独复制所需文件。

源码启动的 Windows Desktop 使用 `apps/desktop/.desktop-build/development/home` 保存应用数据，使用 `apps/desktop/.desktop-build/development/electron-user-data` 保存渲染器本机偏好。先关闭 Desktop，再对两处目录做一致备份；传到新设备的隔离位置后再恢复，不覆盖目标设备较新的历史。desktop profile 包含策展存储与图片文件，优先保留完整应用数据目录，而非只复制某个数据库或图片文件夹。

新设备的工作区路径和账号授权可能不同，需选择存在的本地 Workspace，并按需重新授权供应商。不要把 profile 数据或凭据提交进 Git，不要编辑 Session JSONL/SQLite 修复历史，也不要认为本地测试包已经能够从 GitHub 下载。

<a id="handoff-prompt"></a>

## 继续会话提示词

仓库在新设备可用后，可将以下提示词直接粘贴到独立的新会话。

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
