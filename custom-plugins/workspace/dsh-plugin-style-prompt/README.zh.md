---
description: "通过已配置的视觉 API 提取图片风格，导出新画面提示词与手动参考图使用方案。"
kind: "package-bundle"
---

# 风格提示词

[English](README.md) | 中文

## Summary

风格提示词使用 DSH profile 已配置的视觉模型分析参考图。选择可迁移的风格规则、描述新画面后，可获得中英文提示词、差异化变体和参考图使用方案。工作台保存分析和提示词历史。参考图片与提示词由你手动交给生图平台；本组合包不执行生图或模型训练。

## Table of Contents

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

风格提示词随 CLI 和 Desktop 运行时提供，在**插件 → 已安装插件**中拥有独立开关。新建 Web/Desktop profile 默认启用；已有 profile 保留原有选择，可在插件页直接启用，无需安装归档。启用后在侧栏打开**风格提示词**。

使用 `pnpm --filter dsh-plugin-style-prompt run build` 构建此工作区。包中发布 `index.js`、`client.js`、[cordis.patch.yml](cordis.patch.yml)、展示文案和图片资源，独立组合包行为 `style-prompt`；Desktop 打包会将本地 tarball 加入生产依赖集合。无法热加载 JavaScript 变更的 profile 在替换安装构建后需要重启。

### 分析和创建提示词

1. 在项目模型设置中配置支持图片的模型，再在工作台选择该模型；无需重复填写 API 密钥和端点。
2. 将本地图片拖入导入区，或点击**选择图片**，再选择分析维度并点击**分析风格 · 调用 API**。有效批次会替换当前选择；格式不支持、包含空文件或超出 profile 限制时，整批拒绝并保留原有选择。导入只创建本地预览，开始分析后才发送图片。原主体、场景限定关系与不确定性单独保存，不混入可迁移规则。
3. 勾选希望保留的风格规则；未知规则和仅限当前场景的规则不能成为可迁移的风格要求。
4. 填写新画面和希望改变的内容。**生成 3 个差异变体 · 调用 API**复用已保存分析，发起一次纯文本请求并输出中英文提示词。填写可选英文内容后，也可使用**快速组合 · 不调用 API**。
5. 下载 JSON 或 Markdown。JSON 参考图配置记录图片名称、校验和、选中规则及手动上传要求，不包含图片字节或供应商凭据。请自行在生图平台上传参考图。

历史记录属于当前 profile，重启后仍可读取。停止任务或卸载插件会中止本地 API 工作；已发送请求仍可能计费。中断工作会明确标记，不会自动重新提交。在同一工作台仍打开的情况下，重试响应丢失的受理请求会复用任务 ID。删除分析前，需要先删除其关联提示词记录。

### 部署配置

组合包行接受 [config.ts](src/host/config.ts) 中校验的字段，限制图片数量与字节、上传/请求/输出字节、模型超时与输出 token、并发、历史任务总数、历史页大小和轮询间隔。默认允许四张图片，每张最多 8 MiB、合计 32 MiB，任务截止时间 180 秒，输出预算 8192 token。模型路由来自 profile 注册表。模型缺失、仅支持文本、JSON 无效或响应截断都不会成为成功分析。历史任务已满时会拒绝新任务，直到删除记录或调整限制。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Host 使用公共 LLM、附件和存储域服务。每个任务固定输入，并在派发前保存实际辅助模型指令、文本、附件引用与解析后的调用设置。用量和终态元数据独立保留，不保留私有推理正文。每个 profile 的写入租约阻止竞争进程同时修改存储域；关闭时先排空受理工作，再释放存储。终态无法写入时停止新任务，并通过独立诊断报告。

[分析指令](src/shared/prompts.ts)分离内容与可迁移风格；合成只使用明确选中的规则和新需求。[编译与导出](src/shared/compose.ts)拒绝不存在、未知或仅限场景的规则，不杜撰后端强度参数。FLUX.2 导出采用正向描述，不输出负面提示词 API 字段。[原生工作台](src/client/workbench.tsx)复用应用的 React 和 UI 基础组件，侧栏注册随生命周期撤销。上传、历史记录与参考图预览通过已鉴权的 profile 路由传输。

工作台沿用视觉策展的紧凑工具栏、主工作区、右侧检查面板与可折叠历史记录。参考图片和提示词导出分属两个标签页，模型选择与风格规则保留在右侧面板。分析维度使用共享 Pill 控件按两列排列，较长的线条维度独占末行，显示勾号与已选数量，支持键盘操作，任务进行时锁定选择。组件使用应用统一的 Menu、SegmentedTabs、Button、Checkbox 与主题变量。构建会将优化后的素材内嵌到 Client 入口，已安装包不依赖工作区素材 URL。

维度标题旁使用小幅[材质样本插图](assets/style-dimensions-v1.webp)装饰，由内置图片工具按已保存的[素材提示词](assets/style-dimensions-v1.prompt.txt)生成，WebP 保留透明通道以适配明暗主题。

风格规则使用可选择的卡片，英文表述与可见依据放入可展开详情。详情与历史记录复用共享折叠动画，并适配减少动态效果设置。

图片导入区使用独立的透明[图片收纳盒素材](assets/reference-import-v1.webp)，由内置图片工具按已保存的[素材提示词](assets/reference-import-v1.prompt.txt)生成。拖入高亮适配当前主题，并在放下图片或进入任务状态后清除。文件选择与拖拽共用当前 profile 的格式、数量与字节检查。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [自定义插件架构](../../architecture.md)
- [提示词源码研究](../../docs/research/2026-10-28-image-style-prompt.md)
- [API 集成测试](tests/native.test.ts)

-----

<a id="model-experience"></a>
## 模型体验

工作台显式发起辅助 API 调用，不安装全局指令、Skill 或 Agent 工具。分析收到实际原生图片附件和有界的结构化输出指令；变体生成只收到选中风格规则、原内容排除项和新画面文本。快速组合与导出不调用模型。主对话行为和 Session 格式保持原状。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

Schema 和规则 ID 校验无法证明语义准确，也不能保证成图既保留目标风格又与参考图有足够区别。单图风格仍属初步判断，不同模型连接可能返回不同观察；无效或不完整输出需要显式新建任务。通用参考图配置是描述性数据，不是供应商 API 请求。导出校验和对应已保存的附件字节，原生规范化后可能与上传原始文件不同。付费供应商质量评估和自动生图不属于无密钥测试夹具。

<a id="dev-note"></a>
## Dev Note

无。
