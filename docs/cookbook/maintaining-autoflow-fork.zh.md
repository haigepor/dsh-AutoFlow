# 合并官方更新时维护 AutoFlow 改动

[English](maintaining-autoflow-fork.md) | 中文

## 概要

本指南用于在解决合并冲突前，对照 AutoFlow 定制与官方更新。先记录准确的提交，再按所属模块审查行为、重新生成派生目录，最后验证完整应用。各功能的具体约定仍以所属软件包 README 为准；本指南负责更新步骤和对照地图。

## 目录

- [1. 记录比较版本](#1-record-the-comparison-revisions)
- [2. 审查定制地图](#2-review-the-customization-map)
- [3. 按行为解决改动](#3-resolve-changes-by-behavior)
- [4. 验证合并后的应用](#4-validate-the-merged-application)
- [5. 更新维护记录](#5-update-the-maintenance-record)
- [进一步阅读](#further-exploration)
- [开发备注](#dev-note)

<a id="1-record-the-comparison-revisions"></a>

## 1. 记录比较版本

官方仓库是 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，在本指南基线时的默认分支为 `master`。AutoFlow 发布 `main`，`origin/deepseek-harness` 保存官方镜像。每次更新时重新核对远程地址和分支名称；镜像可能落后于官方仓库。

每次更新的比较起点是定制提交系列开始前的 AutoFlow 提交，以及先前已核实的官方镜像提交。将准确标识记录在本次更新的提交或拉取请求描述中，历史引用归属于这些记录；本指南链接持续维护的分支，不在仓库文档中嵌入提交标识。

1. 从干净检出开始，记录当前 AutoFlow 提交、旧官方提交、拟合并的新官方提交，以及它们的共同祖先。单独备份本机 profile 文件，Git 无法恢复这些文件。
2. 拉取已经核实的远程引用。分别审查新旧官方提交之间的变化，以及共同祖先到当前 `main` 的 AutoFlow 改动。
3. 从已记录的 AutoFlow 提交创建更新分支，在该分支合并官方更新并解决冲突，保留正在使用的 `main`。
4. 解决冲突前保存检查点。验证失败时返回检查点，不改写已经发布的历史。

本次检出使用过的只读检查命令：

```sh
git remote -v
git rev-parse HEAD origin/main origin/deepseek-harness
git merge-base HEAD origin/deepseek-harness
git diff --name-status origin/deepseek-harness...HEAD
git log --oneline origin/deepseek-harness..HEAD
```

<a id="2-review-the-customization-map"></a>

## 2. 审查定制地图

对每个受影响模块，同时比较实现、语言字典、测试、预期输出和 README。下表列出需要保留的行为；如果官方实现已经满足要求，应保留官方改进，逐项合并定制，而不是整文件保留旧版本。

| 所属模块与文档 | 需要保留的行为 | 审查位置 |
|---|---|---|
| [设置外壳](../../packages/client/ui-settings-general/README.zh.md)、[设置服务](../../packages/client/ui-settings/README.zh.md) | 设置独立页面、分组导航、折叠图标栏、本地化搜索和返回导航；底部不出现配置文件区域。 | `SettingsPage`、`SettingsNavIcon`、`search.ts`、各注册消费者、焦点恢复、未加载模块和资源释放。 |
| [主题](../../packages/client/ui-theme/README.zh.md) | 统一页面尺寸；模式、配色、字体、圆角和动画选项；旧字体设置仍可读取。 | `ThemeSettingsPage`、`PalettePreview`、主题所属变量、语言键、已保存偏好的兼容性。 |
| [侧栏](../../packages/client/ui-sidebar/README.zh.md)、[布局](../../packages/client/ui-layout/README.zh.md)、[官方品牌](../../packages/client/ui-brand-official/README.zh.md) | 紧凑且对齐的图标、单一品牌标识贡献、一致的折叠时间，以及 Windows 标题栏行为。 | 品牌插槽、布局列宽、折叠文字、右侧栏过渡和工作区缩进。 |
| [模型](../../packages/client/ui-settings-models/README.zh.md) | 与实际布局一致的首次骨架屏、刷新保留草稿、紧凑模型控件、稳定的标签与删除覆盖、提供商折叠栏和设置页固定操作区。 | `ModelsSection`、`ProviderEditor`、`ModelsSkeleton`、折叠焦点、窄屏和两种主题。 |
| [模型清除](../../packages/client/ui-settings-models/README.zh.md) | DeepSeek 只清除符合条件的用户覆盖并保留入口；保护共享、只读和环境凭证。 | `provider-reset.ts`、修订号冲突、已完成阶段的重试，以及删除凭证前重新核对归属。 |
| [Agent 预设](../../packages/client/ui-agent-preset/README.zh.md) | 四张匹配的加载卡片、刷新保留内容、重试、响应式鲸鱼插画、确认写入后的默认切换和紧凑说明弹窗。 | `AgentPresetSection`、`section-store`、`PresetIllustration`、弹窗焦点、减少动画和四张实际引用的 WebP 素材。 |
| [插件清单](../../packages/client/ui-settings-plugin-inventory/README.zh.md)、[插件设置](../../packages/client/ui-settings-plugins/README.zh.md) | 两种作用域默认折叠；紧凑且居中的卡片标题、详情动画、一致图标、本地化描述和隐藏冗余实例标签。 | `InventoryDisclosure`、模块描述精确匹配、未知插件回退、单标签栏隐藏，以及详情中保留实例身份。 |
| [会话](../../packages/client/ui-conversation/README.zh.md) | 建议只填充草稿，不自动发送；输入历史有容量与作用域限制，并遵守输入法、光标和菜单按键优先级。 | 欢迎页插槽、输入历史解析、草稿恢复、工作区不可用状态和键盘路由。 |
| [提问](../../packages/client/ui-user-questions/README.zh.md)、[基础组件](../../packages/client/ui-primitives/README.zh.md) | 紧凑提问区域和可复用的鼠标、焦点高亮，不改变其他调用者的默认行为。 | 折叠焦点、答案保留、`GlideHighlight.bridgeGaps`、监听器与动画帧释放。 |

AFP 是独立的自定义插件，其源码、描述和 profile 选择仍由该插件管理；解决插件清单冲突时，不新增针对 AFP 的全局样式覆盖。

<a id="3-resolve-changes-by-behavior"></a>

## 3. 按行为解决改动

先审查源代码，再处理生成结果。优先核对 API 签名和注册生命周期，再基于已经验证的行为调整外观。

1. 官方修改插槽、注入服务、存储状态或公共类型时，同步更新所有消费者。将 `settingsSearch`、欢迎页贡献、品牌贡献及其生成插槽声明一起检查。
2. 明确处理异步状态：旧读取不能覆盖已确认的预设选择；已有内容刷新不能退回空骨架屏；后续阶段失败时不能重放已经完成的清除阶段。
3. 草稿或答案需要保留时，折叠内容保持挂载。关闭区域仍需不可交互；快速反向切换和减少动画偏好仍需正常工作。
4. 使用所属生成器重新生成 `slot-catalog.ts` 等声明。不手工解决生成目录的冲突，也不把 Client 服务加入仅面向 Host 的目录投影。
5. 只保留实际引用的插画素材。构建输出、源码映射、截图、图片生成草稿和克隆的研究仓库不进入源码提交。
6. 同时协调中英文文案并重新记录配对摘要。先审查实际页面，再更新浏览器预期，不能仅因为测试失败就刷新快照。

第三方 bundle 安装在各设备的 DSH Home 中。本次审查使用的 Web profile 已移除 `dshmarket` 和 `@michengai/dsh-codex-ui`，并保留 AFP；拉取或合并 Git 改动不会替另一台设备安装或卸载这些 bundle。调整设备的安装清单前，备份 profile 清单、覆盖配置和锁文件；凭证与认证启动地址不得提交。

<a id="4-validate-the-merged-application"></a>

## 4. 验证合并后的应用

先运行覆盖合并改动的最小测试集，仅在共享接口变动或失败原因不明时扩大检查。执行更新的维护者负责合并后验证；下列命令不表示未来合并已经通过。

```sh
pnpm exec vitest run packages/client/ui-agent-preset packages/client/ui-settings-models packages/client/ui-settings-plugin-inventory packages/client/ui-settings-general packages/client/ui-settings packages/client/ui-conversation
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/agent-preset-authoring.e2e.ts apps/web/tests/agent-preset-selection.e2e.ts apps/web/tests/models-page-layout.e2e.ts apps/web/tests/plugin-inventory-polish.e2e.ts apps/web/tests/settings-navigation.e2e.ts apps/web/tests/settings-chrome.e2e.ts
pnpm run build
pnpm run test:docs
pnpm run doc-sync
pnpm run lint
git diff --check
```

浏览器测试脚手架提供无密钥 profile 和页内目录选择器。手动启动 Web 时，通过 `dsh web` 使用 `apps/web/tests/pin-browse-picker.overlay.yml`，保留独立基准服务及其端口。判断视觉结果前先构建，并对照 `.dsh-build/client-build-environment.json` 与源码提交。

验证首次加载、失败重试和已有内容刷新；延迟写入时的预设选择；共享或只读凭证下的提供商清除；折叠后的焦点；窄屏、浅深主题和减少动画。检查实际加载插件是否符合本机 profile，以及卸载市场 bundle 后旧市场入口是否消失。

对照已记录基线中的具体失败源码和预期，区分已有失败与回归。记录命令、失败位置和所属模块。不放宽样式断言、不跳过失败测试，也不因部分测试通过而声称全部通过；发布前修复合并引入的回归。

<a id="5-update-the-maintenance-record"></a>

## 5. 更新维护记录

定制所属模块发生迁移、官方替代某项功能或需求被取消时，更新对照地图。只有替代方案保留要求的行为并通过所属测试，才能删除对应条目。

每次更新在提交或拉取请求描述中记录旧官方提交、新官方提交、合并前 AutoFlow 提交、最终提交范围、解决的冲突、删除的定制、实际执行的检查和剩余失败。本机截图和日志保存在 Git 外；提交文件只链接可移植的文档。

<a id="further-exploration"></a>

## 进一步阅读

- [开发与构建流程](../development.zh.md)
- [测试归属与 profile](../testing.zh.md)
- [双语文档记录](../i18n/README.zh.md)
- [Web Client 注册与渲染](../subsystems/web-client.zh.md)

<a id="dev-note"></a>

## 开发备注

本指南只负责 AutoFlow 定制审查，不授权实际合并官方代码、不修改 profile 凭证，也不替代持久化格式迁移要求。
