---
description: "安装可复制的 DSH 组合包，独立启用提示词、Skill、可执行操作、Agent 工具和页面入口。"
kind: "package-bundle"
---

# dsh-custom-plugin-demo

[English](README.md) | 中文

## Summary

把这个 npm 组合包安装到一个 DSH profile，然后在**插件**页面按需启用功能。demo 提供已分类的全局提示词、Skill，以及由 Agent 工具和设置页面按钮共用的脚本与工具。三个功能首次安装均关闭。提示词和 Skill 使用共享的 DSH Home，因此只要任一 profile 启用，其他共用 Home 的 profile 也可能读到它们。

## Table of Contents

- [使用组合包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用组合包

### 安装到 profile

从仓库根目录验证包，并安装到隔离的 Home：

```powershell
cd D:\project\deepseek-harness\custom-plugins\docs\demo
npm test
npm pack --dry-run
$env:DSH_HOME = Join-Path $env:TEMP 'dsh-demo-check'
cd D:\project\deepseek-harness
pnpm dsh plugin --profile web add 'file:D:/project/deepseek-harness/custom-plugins/docs/demo'
```

CLI 安装时三个可选行默认关闭。Web **插件**页的**添加插件**接受相同本地路径或 npm 包标识。安装完成页会先显示三个功能选项，再启用组合包。详情页按提示词注入、技能、脚本与工具分组，并为每类显示对应图标。之后可在已安装卡片的详情页修改，包括组合包关闭时预设。详情页还在生成的素材图上显示三个示例提示词；点击后打开新会话并填入未发送的草稿。组合包启用时，设置侧栏才会显示 demo 入口。没有热重载的 profile 可能需要重启。

发布自己的副本前，按[架构文档](../architecture.md)修改 npm 名称和所有关联标识，替换示例内容，核对 `@deepseek-ai/dsh` peer 版本，并运行 `npm test`、`npm pack --dry-run`。只用自己控制的 npm 名称执行 `npm publish`。使用者可在**插件 → 添加插件**输入 `your-name@version`，或运行 `dsh plugin --profile web add your-name@version`。此包不声明应用 `bin`。

### 启用、停用与移除内容

**全局提示词**与**示例 Skill**独立选择。提示词行只向 `$DSH_HOME/AGENTS.md` 写入带标记段落；Skill 行只在 `$DSH_HOME/skills` 暴露归属目录。最后一个使用者停用后，内容移到扫描路径外的 `$DSH_HOME/.managed-plugins/dsh-custom-plugin-demo/inactive/`。再次启用会恢复副本，包括对托管内容的修改。全部 profile 停用后，可在设置页面永久移除停用副本。原有 AGENTS 内容和其他 Skill 目录不会被删除。

**示例执行**选项注册 `custom_plugin_demo`，并允许设置页按钮调用同一脚本。关闭组合包会卸载 Client UI、Host 操作和 Agent 工具，但保留功能选择。应使用新会话核对停用后的提示词和工具不再进入模型请求；旧会话的历史内容不会被改写。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入 Client 与管理根行，以及独立的提示词、Skill、执行行。[`package.json`](package.json) 声明可选功能、Client 入口、本地化元信息、示例提示词和发布文件。[`demo-managed-content.js`](src/host/demo-managed-content.js) 保存按进程和 profile 区分的持有记录与停用副本；[`execute.js`](execute.js) 通过插件管理 Remote 提供共用操作。[`client.js`](client.js) 注册设置页面；组合包详情由管理器渲染，不再显示重复状态面板。跨包规则见[架构文档](../architecture.md)。

</details>

-----

<a id="model-experience"></a>
## 模型体验

执行行启用后，Agent 可调用 `custom_plugin_demo` 并获得包内脚本的文本输出。提示词或 Skill 行启用后，新请求可通过 DSH 原有全局记忆和 Skill 提供器加载内容。关闭功能不会改写既有会话历史。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

共享 `$DSH_HOME` 的提示词与 Skill 扫描没有 profile 隔离。标记损坏、同名 Skill 冲突或其他进程仍在持有功能时，管理操作会拒绝继续；检查报错路径后再重试。替换已安装 JavaScript 可能需要重启 profile。示例操作只输出无副作用的演示文本；分发前应替换脚本和工具说明。

<a id="dev-note"></a>
## Dev Note

无。

## 开发目录与配置

`cli/demo-task.mjs` 是托管任务脚本，`src/host/demo-managed-content.js` 管理提示词与 Skill，`src/client/demo-client-entry.js` 是浏览器源码。`scripts/build-client.mjs` 生成根目录 client.js；修改浏览器代码后先安装本包开发依赖并运行 `npm run build:client`。包内 config.json 是三个关闭状态的模板；用户的实时选择保存在 profile 私有 `.plugins/dsh-custom-plugin-demo/config.json`，升级不覆盖选择。
