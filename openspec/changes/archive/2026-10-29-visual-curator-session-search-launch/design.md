## Context

现有 TaskDialog 同时承担找图、用途维护与裁图参数编辑。search-start 要求 usageRevisionId，SearchWorker 将通过来源复核的候选交给裁图子流程。原生 SessionController 已提供创建、命名、提交去重和停止；WorkspaceRegistry 提供真实工作区及会话归属；FileUploads 提供按 Session 暂存的原生附件回执。Visual Curator 当前仅注入日志 SessionStore，不能把日志创建当作 Agent 启动。

## Goals / Non-Goals

**Goals:**

- 默认只需选择工作区，可修改预填需求、数量和输出方式，一次“开始运行”完成受理。
- 固定当前画像和数据包，创建新原生会话，自动提交含数据附件的首条消息；关闭页面不丢弃已受理启动。
- 原图模式交付来源原文件；选择用途时保持原有裁剪与复核。
- 对网络回执未知、部分准备失败和重新连接提供原操作恢复，不创建重复会话或重复消息。
- 在同一会话归属下关联找图 Run，展示和停止本次任务。

**Non-Goals:**

不改 Agent loop，不安装包内 SKILL.md，不自动改变全局模型或权限，不自动重新分析过期画像，不放开其他 Session 的私有素材，不覆盖已有草稿，不修改既有数据包格式。

## Decisions

### 1. Host owns launch lifetime and durable identity

新增插件内启动服务，输入为 operationId、workspaceId、modelProfileId、taskBrief、targetCount，以及 original 或 usage 输出选择。受理时记录冻结参数和稳定的候选 SessionId、首条消息 requestId；状态与检查点放入现有插件仓储 aggregate manifest 的版本化 JSON 中。阶段为 preparing、creating-session、attaching、submitting、accepted，失败保留阶段及已有身份，重试只继续缺失步骤。原生会话创建后核对返回身份和工作区，不能对已开始的会话再次执行可能自动另建会话的 create。

启动操作由已验证的 workbench owner 发起，适配层复用原生服务；命名、附件受理、首条消息与执行可追溯。只有收到首条消息受理回执才报告已受理；真正的找图进度来自后续 Session-owned Run。浏览器仅观察和导航，不在组件中持有后台启动事务。相比浏览器串联 create/upload/prompt，Host 检查点可覆盖关闭和断线恢复。

### 2. Native services remain the owners of Sessions and attachments

原生能力通过窄类型适配器提供工作区列表、定址 Session 创建、恢复检查、命名、文件上传、消息提交及取消。生产适配器从已公开的 sessionController、workspaceRegistry、fileUploads 和 Session 服务读取，不引入对 Client 组件内部的依赖。缺失能力返回明确不可用，不阻止原有 headless 工具和画像页面加载。

原生上传回执可能随进程重启失效，因此持久检查点记录数据包身份，恢复提交前重新暂存同一文件；先核对原 requestId 是否已进入队列或历史。文件附件保存完整包，提示词只包含目标、固定版本、参数、读取附件与执行工具的说明，不将整个包作为系统指令。

### 3. Preserve-original and usage output are explicit execution choices

新增显式 output 选择：original 不需要 usageRevisionId，usage 使用已有不可变用途。未携带新选择的旧调用继续要求用途，历史冻结 spec 保持原义。新选择进入任务固定输入和模型工具说明，更新所有插件内调用者。

原图模式完成去重、实际来源像素及最终视觉复核，直接记录原图合格选择，不调用裁剪。分析可以使用归一化像素，但可下载交付必须指向经摘要校验的 originalBlob。保存到工作区使用本次启动授权与会话归属校验，仅覆盖该启动的合格结果，不能成为导出任意私有素材的通道。指定尺寸继续复用现有裁图流程。

### 4. Freeze current rules and prepare the matching package

启动检查画像新鲜度及启用规则，固定 profileId、contentDigest、规则选择、组条件和执行预算。同版本数据包复用；缺少时生成同格式参考包。画像后来改变不回写已启动会话。提示词使用当前启用规则及组条件，旧 matchingPrompt 不覆盖它们，模型建议不变成人工确认。私有画像或图片不属于新 Session 时明确拒绝，保留当前权限。

### 5. Simple UI reuses native workspace and task presentation

找图入口使用独立简易弹窗，裁图入口保留已有表单。界面显示真实工作区的标题和路径、预填需求、目标数量和默认原图输出；用途选择才显示预设尺寸。只读摘要展示画像和数据集状态。提交错误与字段相关时原位显示；已受理后可关闭，工作台卡片提供打开会话、继续启动或停止本次找图。

原生客户端通过注入的 sessions/workspaces/navigation 能力刷新和打开精确 sessionId，不调用只准备草稿的 startSession，也不复用已有空白会话。会话模型沿用原生默认，视觉复核沿用插件配置；不调用会顺带修改全局默认的模型选择操作。

### 6. Session and background Runs remain linked

搜索由原生会话的工具执行，Run 的 owner 为该 Session。启动记录与模型可见首条消息包含固定参数和包身份，查询关联任务不依赖模型生成的文字。停止本次找图请求取消原生执行及该 Session 的关联视觉 Run，已保存结果保留；普通关闭或导航不取消。结果通过原生工具卡片与插件任务列表展示，并提供授权原图或指定尺寸成品的保存位置。

## Risks / Trade-offs

- 原生创建成功而检查点失败 → 创建前固定候选身份，恢复检查真实 Session 和归属，禁止盲目再次 create。
- 首条消息已受理但网络断开 → 沿用 requestId 并检查原生队列/历史，不生成第二条指令。
- 文件回执重启失效 → 从冻结包重新上传同一字节，受理去重仍由原生 requestId 保证。
- 任务模型未调用工具 → 保持“会话已受理/规划中”与“正在检索”不同状态，夹具验证真实工具调用和 Run 关联，不能伪造运行进度。
- 工作区不可写或路径被替换 → 创建前校验工作区，保存时复核目录归属、路径及文件摘要，失败不覆盖现有文件。
- 现有工作区有其他未提交修改 → 实施前记录目标副本与哈希，仅改本变更拥有路径。

## Migration Plan

私有启动 aggregate 使用明确版本和新增字段；既有 Run 的 spec/data JSON 与数据包继续可读。旧 search-start 调用不自动改成原图，显式新增模式后才采用新行为。先完成原图模式与测试，再接入原生启动和 UI。回滚恢复本次目标文件副本并重建；不删除用户已产生的 Session、数据包或交付文件。

## Open Questions

无产品决策未决项。默认原图、按需选尺寸及独立变更已由用户确认；实现中如发现原生接口缺口，应先修订本设计再扩展接口。
