---
description: "AFP 图片搜索、可续跑视觉筛选及明确确认后的私有收藏夹写入。"
kind: "package-bundle"
---

# dsh-plugin-afp

[English](README.md) | 中文

## Summary

这是安装到 DSH profile 的独立 npm 组合包。只读工具、视觉刷新、远端写入、六个 Skill 和三个操作台入口分别开关。默认开启三项 Agent 工具、六个 Skill 和全局面板；设置入口和会话 Tab 默认关闭。远端写入仍须经过写入计划和明确确认。所有入口显示同一 profile 的任务与报告，切换会话或关闭页面不会停止任务。

## 安装与开发

在本包目录依次运行 `pnpm install --ignore-workspace --config.auto-install-peers=false`、`npm run build:client`、`npm test`、`npm run check`、`npm pack`。通过 `dsh plugin --profile web add <绝对路径的tarball>` 或“插件 → 添加插件”安装打包产物。开发时也可执行 `dsh plugin --profile web add file:D:/project/deepseek-harness/custom-plugins/workspace/dsh-plugin-afp`。使用当前仓库构建的 DSH；此前发布的运行时尚不支持新的 featureConfig 声明。

用自己的 npm 账号发布经过审核的包后，用户可在同一插件页面输入 `dsh-plugin-afp@<版本>`，或运行 `dsh plugin --profile web add dsh-plugin-afp@<版本>`。无需全局安装。包不声明独立应用 bin。代码来源及发布限制见 [UPSTREAM.md](UPSTREAM.md)。

## 目录约定

根目录 `index.js`、`execute.js`、`skill.js` 和生成的 `client.js` 是导出的生命周期入口；`config-schema.js` 校验部署配置。自有 Host 实现放在 `src/host/afp-*.js`；浏览器实现放在 `src/client/afp-*.js`；适配的协议与分类实现放在 `src/vendor/auto-afp-img/`。`skills/` 只存技能说明和参考文档。根目录 `cli/afp-task.js` 导出 DSH 托管的任务适配器，与 UI 调用同一个 Host 服务；`scripts/` 只存本包构建和检查脚本。修改浏览器源码后运行 `npm run build:client`，不直接修改生成的 client.js。

## 实时配置

包内 `config.json` 只提供初始模板。唯一的用户功能配置是 `<profile>/.plugins/dsh-plugin-afp/config.json`，包含 `version: 1` 和完整的布尔值 `features` 表。插件页面保存与手动修改都使用这份文件。有 HMR 时监听文件；没有 HMR 时重启生效。非法文件保留现场并显示错误，失败的 HMR 读取保留此前运行状态；页面保存后启用失败会恢复旧文件及运行选择。首次创建时迁移明确的旧行选择，后续启动和升级保留用户文件。修改功能 ID 或文件版本时须提供显式迁移，不直接覆盖选择。

功能键是 `read`、`refresh`、`write`、`ui-settings`、`ui-panel`、`ui-conversation` 及六个 Skill 目录名。插件详情和操作台区分已选择与实际运行状态。Home 和命令行部署覆盖仍有更高优先级。关闭组合包保留全部选择；关闭一个页面入口只移除该入口；关闭刷新或写入能力会取消并等待相关任务释放资源。AFP 不包含提示词注入功能。

凭据通过 DSH 凭据服务读取：`AFP_ACCESS_TOKEN`，或 `AFP_USERNAME` + `AFP_PASSWORD`，以及 `VISION_API_KEY`。这里只配置引用名称，不能写入凭据值；token 缓存也保存在凭据服务。配置弹窗只有在 AFP 用户名和密码均已填写时才启用“获取令牌”；它会先保存当前填写值，再复用运行时的登录流程取得或刷新令牌。请求期间按钮显示加载动画，令牌不会回显到页面或写入插件 JSON。Cordis 根行 `afp` 配置 `visionBaseUrl` 和 `visionModel`，示例见 [config.example.patch.yml](config.example.patch.yml)。接口地址、模型、超时、预算和 `pollIntervalMs` 属于部署配置，不进入功能 JSON。旧 `allowWrites` 字段仅为已有运行记录兼容而接受，不再赋予写入权限；写入由 `write` 功能行控制。只提供 token 时，更换 token 会改变账户标识；提供用户名可保持标识稳定。

## 操作台与工具

三处入口分别注册 `settings.section`、`sidebar.panellist` + `main`、`conversation.view`，随生命周期撤销。操作台提供凭据状态、功能开关、分类选择、收藏夹数量、离线搜索规划、视觉 dry-run、续跑、取消、报告及 append/replace/clear 写入计划确认。任务属于当前 profile；会话 Tab 展示同一组任务。会话壳在已有非空会话显示 Tab。移除全局入口时，当前面板返回会话；设置和会话页由现有壳处理导航回退。

Agent 工具名称保持稳定：`afp_status`、`afp_search_plan`、`afp_collections`、`afp_report`、`afp_plan_change`、`afp_refresh`、`afp_apply`。Agent 任务属于调用会话，并走 DSH 确认流程；页面任务属于 profile。页面先预览精确目标及增删数量，再提交一次性、有期限的确认凭据；凭据在任务入队前消费，重启或关闭写入后失效。两种入口都会在写入前复核账户、精确私有目标名、完整收藏夹成员和引用的运行记录，并在第一次修改前消费计划。写入不自动重试或回滚；失败、取消可能已经部分写入，须先检查保留的报告和收藏夹，再生成新计划。

## 内容归属与恢复

六个 Skill 分别在 `$DSH_HOME/.plugins/dsh-plugin-afp/skills/` 保存进程/profile 持有者。最后一个持有者停用后，托管目录从 `$DSH_HOME/skills/` 移入私有停用区；对托管内容的编辑会保留并在再次开启时恢复。同名用户目录、归属标记损坏、链接路径和副本冲突会拒绝覆盖。由于扫描目录共享，同 Home 的另一个 profile 仍可能使 Skill 可见。异常退出的持有者在下次管理操作核对恢复；已有会话历史不会删除。

原有 run/plan UUID 及记录位置保持稳定：`$DSH_HOME/.plugins/dsh-plugin-afp/profiles/<profile-hash>/`。视觉任务失败或取消保留 pending 候选和游标，以便续跑。Home 范围的账户/运行锁阻止并发操作；不完整锁或遗留恢复锁会拒绝工作，须停止持有者后检查现场。报告只返回数量和脱敏错误，不返回凭据或预览字节；本地运行记录仍包含候选元数据，应作为私有数据保管。

## 验证范围

`npm test` 使用模拟 AFP 接口与隔离的临时 Home，不执行真实 AFP 写入。会话快照测试消费仓库 `pnpm run build:lib` 的产物，独立副本缺少仓库时明确跳过；它记录真实 Agent 循环调用离线搜索及停用后的工具列表。`npm run check` 检查语法、exports、默认功能、发布文档和 UTF-8。仓库聚焦测试覆盖 JSON 选择迁移、单行开关、手动 HMR 修改、启用失败回滚及旧 bundle 兼容。打包安装和浏览器验证使用当前仓库构建。模拟通过不代表线上接口、账户权限或素材使用许可已经验证。

## Dev Note

跨包目录及 UI 槽位规则见[自定义插件架构](../../docs/architecture.md)。

## 功能介绍与配置弹窗

插件详情直接显示类型分组，长列表提供“查看更多”；仅组件列表保留折叠。点击功能名称在列表内展开用途、依赖与停用行为；脚本与工具开关旁的编辑按钮打开共享配置弹窗。弹窗沿用 DSH Modal、Input 和 Button，常用模型与预算字段直接编辑，完整 JSON 收在“高级配置”中。四个凭据字段只写入当前部署引用的 DSH 凭据服务，留空保留已有值；部署 JSON 只存引用名、接口、模型和预算，由 profile 配置编辑器保存并重载。部署保存会取消活动任务，凭据保存不重载。两类保存分别反馈结果；成功的凭据写入不会因后续部署失败撤销。修改引用名后重新打开弹窗再保存凭据。
