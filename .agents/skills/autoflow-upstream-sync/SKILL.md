---
name: autoflow-upstream-sync
description: >-
  Compare and integrate an official DeepSeek Harness release into the AutoFlow fork: verify the deepseek-harness mirror, analyze main customizations, preserve main theme tokens and layouts, merge new behavior, and validate regressions. Use for official release synchronization, main versus deepseek-harness comparisons, and recurring fork upgrades. Do not use for standalone UI redesigns, ordinary dependency updates, or generic Git synchronization outside this repository.
compatibility: Requires Git, Node.js, and the repository's pnpm runtime; browser and platform checks depend on the available environment.
---

# AutoFlow 官方更新集成

把指定官方版本集成到 `main`，保持 AutoFlow 的主题 token、布局和自定义功能。交付包含官方镜像、逐模块对比决定、验证结果及可回退的 Git 提交。只读分析请求到报告为止；不能据此执行合并或推送。

## 先读什么

1. 读取当前根级、相关目录 `AGENTS.md` 和 [架构](../../../docs/architecture.md)。跨模块工作使用 `aide-5-workflow`；不要自动创建 OpenSpec。
2. 读取 [同步记录](../../../docs/autoflow-upstream-integration.zh.md)、[维护对照地图](../../../docs/cookbook/maintaining-autoflow-fork.zh.md) 和文件清单。文档是查找线索，当前 Git、源码与运行结果决定事实。
3. 修改前加载 `ponytail`；Windows 中文编辑加载 `windows-utf8-editing`。UI 适配沿用 `shadcn` 的现有设计系统分支，不初始化另一套组件。完成前加载 `verification-and-delivery`。

## 1. 固定比较版本

记录当前 `main`、镜像分支、旧官方基线、目标官方提交、共同祖先及脏工作区。精确提交 ID 放在提交说明或 Git 外的运行报告中；维护文档使用可解析标签或分支。

```sh
git status --short --branch
git remote -v
git branch -vv
git worktree list
git merge-base main deepseek-harness
```

- 核验官方 URL 为 `https://github.com/deepseek-ai/deepseek-harness.git`。`origin` 是自有仓库，不能当作官方真源。
- 用户指定发布链接时，以该标签为目标。通过发布页和 `git ls-remote` 核验后拉取标签；`master` 更晚的提交不自动纳入此次升级。没有明确目标时才询问版本范围。
- 创建分别保存旧 `main` 和旧镜像的备份分支。未提交、未跟踪目录和本机 profile 单独保留；Git 备份分支不包含这些内容。禁止 `reset --hard`、`clean` 或全量暂存覆盖它们。
- 如果镜像与 `main` 相同或包含定制提交，不能把它作为旧官方基线。通过共同祖先、上次官方标签及历史合并的官方父提交定位真源，说明文档漂移。
- 更新未检出的镜像后，要求镜像提交等于已核验的官方目标提交，且 `git diff --quiet <target> deepseek-harness` 成功。镜像只保存官方源码。
- 修改本地分支与改写远程分支分别记录。只有用户授权推送时才推送；远程非快进更新先备份已观察的旧远程提交，再使用精确 `--force-with-lease=<branch>:<old-oid>`，远程移动则停止。

## 2. 做三方分析

旧官方 → 新官方：本次上游增量。旧官方 → 当前 `main`：本地定制。比较二者同路径交集，并审查没有冲突但自动合并的功能与样式。

只读脚本输出完整路径、文件数、交集、视觉候选和工作区状态，不拉取、不改分支、不编辑文件：

```sh
node .agents/skills/autoflow-upstream-sync/scripts/compare.mjs --local main --mirror deepseek-harness --old dsh-v0.2.0-rc.1 --target dsh-v0.2.0-rc.2
```

以上标签仅为已执行过的示例，下次必须换成当次核验的版本。脚本拒绝混入本地提交的镜像及错误祖先关系；输出中的提交身份来自本地 Git，不能代替远程核验。

逐项记录：旧/新行为、所属源码、公开类型和调用者、持久化、文案、样式、测试、采纳决定、理由、回退点。按入口链追踪，不能只总结发布说明：

| 链路 | 必须比较的消费者 |
| --- | --- |
| `dsh` → profile → bundles → Cordis plugins | CLI、Desktop Host、默认配置、可选 overlay、本机第三方 bundle |
| Host 服务 → Gateway → Remote → Client store → slot | 公共类型、生成 Remote 声明、所有注册与释放点 |
| Session event → projections → Chat / SDK | TypeScript 与 Python 预期、无密钥录制会话、持久化类型确认 |
| theme → primitives → feature UI | 亮暗配色、菜单材质、布局、无障碍、键盘和响应式状态 |

定制审查地图还包括 AFP、全窗口设置及搜索、提供商双栏与模型清除、预设骨架屏及提交反馈、品牌插槽、输入历史、提问折叠与草稿。

## 3. 决定如何集成

| 改动 | 默认决定 |
| --- | --- |
| 官方修复或新功能 | 接入源码、调用者、类型、文案、持久化、测试和文档；保留本地仍需要的能力。 |
| 纯视觉更新 | 保留 `main` 的现有 token 值、颜色、字体默认值、材质、圆角、间距与布局。 |
| 功能必需的新样式 | 在现有 token 上增加新类或语义 token；分别覆盖亮暗、窄屏、键盘焦点和减少动画。 |
| 混合 TSX/CSS | 按代码块适配；不得用整文件 `ours` 或 `theirs` 代替审查。 |
| 实验能力 | 合入官方支持，但保留其显式配置开关；不擅自开启默认 profile。 |
| 上游模型目录变化 | 保留实际目录事实和本地推理强度逻辑；核查失效 ID，不凭旧测试复活目录项。 |

如果接入功能确实需要替换受保护的现有布局，先给出具体影响并请求决定；其他独立工作继续。用户已要求保留 token 与布局时，不再反复请求同一决定。

## 4. 在隔离分支解决合并

从保存的 `main` 创建 `codex/` 集成分支，执行 `git merge --no-commit --no-ff <official-target>`。同时比较有冲突和自动合并的路径。所有生产代码修改都要有对应功能理由。

- 特别核查新 `MenuGroup` 等共享组件替换旧 wrapper 后，本地选择器是否仍命中；不能只保留已经不被使用的 CSS。
- 提问状态机、超时、迟到回答、焦点暂停与只读历史一起接入，保留本地 `AnimatedCollapse keepMounted` 及紧凑排版；验证折叠时不会留下暂停计时的焦点。
- 本地默认预设的提交反馈与上游解除代码视图开关限制一起保留。
- 按生成器归属重新生成 Client slots、Host API、Remote 类型、持久化目录和锁文件，不手工拼接派生类型。Client 编译需等待 Host 类型和运行包构建就绪。
- 两方修改同一持久化类型前驱时，按 [类型审查指南](../../../docs/cookbook/reviewing-persistence-type-changes.md) 恢复单一有序历史。只对允许更新的未最终定版末端记录运行 `--update`；保留已最终定版确认及所有历史 Session generations。生成器拒绝时不得关闭验证或伪造类型摘要。
- 中英文 README 同步确认后，只为实际修改的文档重新记录配对，不全库重刷摘要掩盖翻译漂移。

## 5. 验证并区分已有问题

读取 `dsh-pre-push-checks` 选择最小充分证据。运行功能所属测试、受保护定制的回归、Host/Client 编译、构建、相关静态门禁、文档检查和 keyless snapshots。无需默认运行全库 coverage。

UI 使用 `playwright-mcp` 的实际页面及亮暗截图；先探测工具。仓库已有 Web e2e 用其标准 profile 运行。手动 Web 启动带 `apps/web/tests/pin-browse-picker.overlay.yml`。截图、日志、临时运行脚本与本机认证 URL 保留在 Git 外。

失败必须分类：

- **合并回归：** 修复后复跑受影响证据，已知回归不能集成到 `main`。
- **已有失败：** 在保存的旧 `main` worktree 用同一断言复现，比较错误；不放宽样式门禁来声称通过。
- **环境限制：** 保留具体错误，例如本机缺少 Windows C++ 编译工具，不能宣称对应平台运行通过。
- **新会话待验：** 技能文件与 frontmatter 校验不等于新 Codex 会话已自动发现它。

原本失败与回归不能混为一谈。失败报告包括命令、用例、基线证据、原因和剩余验证责任。

## 6. 交付与提交

更新同步记录及文件清单；历史路径清单可以保留在 `historicalSnapshot`，当前条目使用当前官方标签与集成分支。维护对照地图只更新实际变化的定制责任，不复制上游发布说明。

精确暂存本次路径，排除预先存在的未跟踪目录。提交前检查暂存差异、UTF-8、冲突标记、尾换行、配对和 secrets。合并提交说明记录双方基线、集成决定、实际检查、已有失败、环境限制和回退分支。技能单独提交以便独立恢复。

只有集成回归已解决才将 `main` 快进至集成结果。不自动发布版本、安装或卸载本机 bundle、修改凭证、推送或创建 PR。报告本地完成状态和远程状态，不能混称“同步成功”。

## 示例任务

- “把官方 rc.2 同步到 `deepseek-harness`，先分析，再合入 `main`，保持我的 token 与布局。”→ 完整流程。
- “只比较下一个发布版本新增了什么。”→ 固定引用、分析、报告，到此停止。
- “镜像分支误指向定制提交，先修复它。”→ 保存旧引用，核验官方目标，仅修复镜像及报告。
- “重设计设置页。”→ 不触发本技能，交给 UI 工作流。

可复用案例见 [evals/evals.json](evals/evals.json)。
