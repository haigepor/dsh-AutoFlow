---
description: "可选 DSH profile 层，提供版本化视觉风格、搜图、裁后复核与可审计人工标签。"
kind: "package-bundle"
---

# dsh-plugin-visual-curator

[English](README.md) | 中文

## 摘要

从选定参考维度建立视觉风格，发布不可变版本，并用同一固定标准搜图和复核真实裁后图片。人工纠正可追溯，只有显式发布才改变未来标准。DSH 随应用提供这个独立 bundle，新建 Web 和 Desktop profile 默认启用其八个 Agent 工具，已有 profile 保留原选择。未配置搜索或视觉接口时仍可读取本地记录，需要这些接口的操作会明确失败，直到配置完整。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 启用 profile 层

已有 profile 在插件管理器启用“视觉策展”，即可使用随应用提供的版本，无需在 profile 内另装一份。更新应用安装依赖后，已运行的 Host 需要重启。未随应用携带本 bundle 的安装环境，也可把审核过的包产物安装到目标 profile。[补丁](cordis.patch.yml) 挂载业务 Provider、六项技能、三组 Agent 工具与三个页面入口，每项均可独立开关。技能通过原生技能目录注册，不向 Home 写入文件。Host 需要 profile 上下文、存储域、凭据、jobs、插件管理、配置编辑、技能目录及 Session 存储。Web Client 使用标准插件管理详情页。本包不提供应用可执行文件；应用通过受支持的 `dsh` profile 启动。

本 bundle 不会把自己加入其他 profile，也不修改 AFP。关闭后会释放注册、停止接收新工作、取消并排空活动任务，同时保留数据。同一 profile 的第二个 Host writer 会被拒绝；先停止原 Host，再重新获取写入能力。

### 配置外部服务

在所属 profile 的 Cordis overlay 中配置 Provider 条目。`source` 定义一个 HTTP JSON 图片来源，包括端点、方法、query/cursor/page-size 字段、响应 JSON Pointer 及允许的媒体 origin。`vision` 指定兼容多图 JSON 的模型和端点。`limits` 控制文件、解码、存储限制，以及请求和候选预算、重试、并发及截止时间。[配置解析器](src/host/config.ts) 是字段与默认值的唯一详细定义；创建任务快照前先解析配置。

`source.endpoint`、可选的 `source.lookupEndpoint` 和 `vision.endpoint` 拒绝内嵌凭据、查询参数及 fragment。`source.allowedMediaOrigins` 和 `vision.localOrigin` 必须填写精确 origin，不含路径或末尾斜杠。可选 lookup 端点仅通过来源稳定 ID 刷新媒体定位，不会从第一页重启已过期搜索。

`vision.vendorVersion` 记录供应商声明的模型版本；未声明时，已保存请求保留重放限制。模型采样、`limits.maxVisionOutputTokens`、`limits.maxReferenceImages` 或 `limits.maxReferenceBytes` 变化会形成新的审核器标识。正式搜图与裁图使用变更后的审核方法前，需要创建新 candidate 并发布对应 release。已有 release 保留原审核方法。

密钥值保存在 DSH 凭据中。本插件只保存凭据引用，初始名称为 `VISUAL_CURATOR_SOURCE_KEY` 和 `VISUAL_CURATOR_VISION_KEY`；修改 JSON 字段并不会保存密钥。来源和媒体使用有界的公网 HTTPS 请求，并检查重定向与 DNS。显式配置的本地视觉 origin 是本地模型的受支持例外。不提供任意请求脚本、模型指定端点或远端收藏夹写入。

预算限制实际尝试次数、字节和耗时。重试消耗同一任务预算；外部请求中断后保留已预留配额，因为供应商可能已经计费。实现报告费用未知，不强制执行货币额度，也不预测最终账单。

### 建立固定风格

插件详情页使用与 AFP 相同的原生布局：图标、示例、说明、分组可选功能及开关，共十二项。技能包括参考图与风格、风格分析与校准、按风格找图、智能裁图与构图、人工反馈整理、数据集与 Skill 导出。工具分为只读工具、找图与裁图、反馈建议与导出，合计仍为八个 Agent 工具，关闭某组仅撤销该组注册。

设置侧栏、全局面板、会话 Tab 三个页面入口默认关闭，启用后显示“页面待设计”占位页；具体内容按新设计逐步搭建。入口状态读取原生插件清单，随插件管理变更与连接重置更新，不使用轮询。关闭入口不删除数据或停止任务。旧工作台不再挂载到详情页，已保存数据及授权 Host 操作保留；此详情页不提供新建数据或人工复核控件。以下章节说明保留的数据操作。

1. 创建风格，导入 JPEG、PNG 或静态 WebP 参考图。选择正例、反例或待判断意图，并指定整体偏好或具体维度。只参考色彩的样例不会为构图或主体打标签。混合批次保留成功项并逐项报告拒绝文件。
2. 分析参考图，获取模型观察和待确认规则建议。程序测量、模型估计与不确定性分别保存。在草稿中确认 required 规则、检查支持图和反例，并解决 required 冲突。
3. 创建 candidate，在具备独立标签时进行对比。发布 provisional 或 evaluated release；evaluated 只表示完成了所声明的对比，不代表自动达成质量目标。发布不选择默认版本；默认选择和回退均需显式操作。
4. 创建独立用途修订，指定精确约分比例、匹配的输出像素、安全区和保护内容。搜图与裁图任务始终使用选定 release、用途、recipe、参考图片字节及预算。

### 复核结果和纠正

搜索结果分别保留原图与成图审核。偏好分不能抵消 required 失败；unknown 和技术失败不会成为审美拒绝标签。只有不重复的最终合格图片计入目标，不足结果保留真实停止原因。缺少足够原图像素的预览不能满足成图像素要求。

人工裁图有两次确认：先完成调整，保存并复核真实派生图；再明确允许作为学习样例。关闭预览、下载、接受一批结果或取消拖动都不会产生理想裁图标签。人工保留的合法但带视觉警告图片，与自动合格结果分开标识。系统不通过放大、拉伸或扩图满足不可能的裁剪要求。

反馈默认只作用于当前任务。明确选择纳入当前风格 candidate 后，纠正才可能用于下一草稿；题材不符、本次不需要和 unknown 与风格拒绝分别记录。改判追加新反馈并移动唯一有效头。旧 release 和导出保留原记录。Agent 建议不会变成人工身份确认。

复核队列字段标记不确定判断、技术失败、人工与模型分歧，以及等待人工判读的新来源组。`limits.reviewSampleRate` 还会根据图片摘要可重复地抽取普通通过或拒绝图片；每个任务在启动时固定抽检比例。队列归属不修改反馈或 release，新来源组也不代表已识别出新的语义类别。

### 限定范围和恢复任务

Client 创建的 profile 任务和 Agent 创建的 Session 任务分别拥有归属。授权的 owner 操作需显式打开所属 Session 通道，才能读取其任务、图片或导出。将 Session 结果保存到 profile 样例库会创建独立关联，原 Session 归属保持不变。

离开插件管理页不会停止任务。暂停和取消会先停止准入、排空在途工作，再确认完成；已提交结果保持可读。Host 重启后，中断任务需要显式恢复，并继续原设置与检查点。资源缺失、Provider revision 变化或续页游标失效会停止恢复并显示错误；重新搜索属于新操作。插件关闭会取消任务，不发布晚到结果。

### 划分、对比和导出

确认 family 成员后，再分配 learning、development 或 holdout。原图、精确重复及其派生图共享 family。尚未确认的近似分组不能证明数据独立；已参与分析或校准的 family 不能成为独立 holdout。holdout 不进入归纳和训练导出；查看其错误并据此修改规则时，需要新建 manifest，将相关 family 移出 holdout。

选择相关来源组并明确确认合并后，重新打开划分表单。合并保存不可变 family 别名和成员确认，原 asset 记录保持不变。旧划分若因合并出现跨集合冲突便不能继续使用，需要创建新划分并将合并组保留在同一集合。

对比保存固定 release/candidate、图片、用途、反馈头、原始计数及分母。召回分母保留全部人工正例，包括待复核、技术失败和未处理状态；精确率统计有人工标签的合格结果。分母为零时显示 unavailable。预算耗尽后仍保存含全部固定输入及明确停止结果的部分报告。仅做图片对比不会生成裁图，也不能证明裁图破坏指标；缺少相应独立裁图监督时，这些指标保持 unavailable。对比不会改变默认 release。

导出支持风格包、classification/preference/crop JSONL 和 Skill Markdown。下载是版本化 JSON 封装：`files` 保存文本内容及 checksum；只有经授权的 with-bytes 导出才在 `resources` 中保存 Base64 媒体字节。文件 checksum 是精确 UTF-8 内容的 SHA-256；业务记录摘要另用带版本的规范 JSON。默认仅导出引用。附带图片字节必须有已记录授权并通过完整性检查；缺失、损坏或未授权字节会使导出失败，不生成被标成完整的缺损包。

training 导出只含 learning family，并保留请求时固定的合格人工反馈 ID。后续改判不会重写已有快照。偏好平局和两者均不合适保留原值。生成的 Skill 指明 release 与所需资源；图片不可用时要求报告缺失，且只产生可下载产物。它不修改 Home 指令、不在 Session 中启用、不训练模型，也不包含模型权重。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节，点击展开</summary>

一个 Host Provider 负责授权、显式输入解析和流程调度。存储域仓储先写不可变依赖，再替换单个 aggregate manifest；只有 manifest 引用的记录可见。expected revision 串行保护修改，operationId 恢复已完成提交，profile 文件锁阻止第二个 Host 打开竞争缓存。提交失败遗留的未引用文件和记录仍为私有。

[领域模块](src/domain/index.ts) 管理风格版本、有效反馈、数据划分、评估和导出快照；[媒体处理](src/media/index.ts) 管理校验字节、几何和有界外部适配。[运行时](src/host/runtime.ts) 将持久任务及 attempt 与进程内 job 分开。[Client](src/client/index.ts) 和 [Agent 工具](src/host/tools.ts) 调用同一 Provider；bundle 补丁不修改 agent loop 或 Session 事件格式。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

[自定义 bundle 架构](../../architecture.md) 定义安装与组合；[存储域](../../../packages/storage/storage-domain/README.zh.md) 定义持久写入；[jobs](../../../packages/jobs/jobs/README.zh.md) 定义进程内执行；[已确认变更](../../../openspec/changes/add-visual-curator-v1/design.md) 定义验收要求。

-----

<a id="model-experience"></a>
## 模型体验

可选工具条目提供有界风格读取、搜图/裁图启动、任务读取、Agent 建议及导出启动/读取，不暴露人工确认、发布、默认切换或分组确认命令。长操作返回任务句柄；启动确认不代表图片合格。工具结果包含安全 ID 和经授权资源引用；辅助视觉请求保存实际图片顺序、摘要、提示词、模型/版本声明及校验后输出。

启用工具时，声明会增加模型工具 schema 上下文。本 bundle 不向每次请求注入风格，也不修改 Home 指令。每次视觉调用消耗自身文本和图片预算；前缀缓存行为及供应商精确 token 计费取决于配置的 Provider，本包未测量这些值。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

仅支持已配置 HTTP JSON 来源和兼容多图视觉协议。不提供任意站点爬取、付费原图获取、图像生成、分割、Embedding/向量检索、模型训练或远端收藏写入。系统只审核已召回候选，不能声明完整图库召回。原图质量、许可、导出授权和审美适用性需要用户自行核验。

keyless fixture 验证流程控制和精确图片几何，不验证真实来源/模型部署、供应商账单、广泛视觉质量或用户参考图适用性。只有提供真实端点、响应映射、凭据引用、模型能力和授权样例后，才能验证相应属性。仅做图片评估时，尚无支持的裁图指标保持 unavailable。profile 锁只协调同一台机器的进程，不支持独立主机共享存储的锁协调。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

无。

</details>
