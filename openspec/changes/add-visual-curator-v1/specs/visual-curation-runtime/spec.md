## ADDED Requirements

### Requirement: R1 Independent bundle and shared Host operations

能力 SHALL 由独立 `dsh-plugin-visual-curator` bundle 提供，Client、Agent 和后台流程调用同一 Host 业务服务，注册由 Cordis effect 管理。第一版 SHALL 不修改 AFP、核心循环或 Session 格式，随应用携带，并由新建 Web/Desktop profile 默认启用；已有 profile SHALL 保留原插件选择并允许从插件管理器启用内置版本，无需安装 profile 副本。headless/SDK/ACP 默认列表 SHALL 保持原状；未配置外部能力时允许读取已有本地记录，依赖该能力的操作明确拒绝。

#### Scenario: R1a Open local data before source setup
- **WHEN** 用户安装独立插件但尚未设置来源或视觉接口
- **THEN** 可以导入受支持图片、编辑草稿和查看历史，依赖缺配置的分析/搜索返回 configuration-required，不隐藏记录或偷偷换模型

#### Scenario: R1b Unload feature registrations
- **WHEN** 用户停用插件
- **THEN** 工具、Remote 与 Client 入口随 effect 释放，在途工作取消排空，原 AFP 行为和用户数据保留

#### Scenario: R1c Ship the independent bundle with the application
- **WHEN** 构建 CLI 和 Desktop 分发，初始化新的 Web/Desktop profile
- **THEN** 安装依赖包含视觉策展，Desktop 本地包闭包必须包含其 tarball，新 profile 默认启用工作台；来源和模型未配置时可管理本地样例，AFP 仍可正常打开

#### Scenario: R1d Preserve existing profile choices
- **WHEN** 已有 profile 升级应用后启用、停用并重新启用视觉策展
- **THEN** 升级不覆盖原 bundle 选择或补丁，插件管理器可直接启用内置版本，停用选择跨重启保留，本地风格在重新启用后仍可读取，profile 不增加视觉策展依赖

### Requirement: R2 Ownership on every resource and single writer

所有记录 SHALL 限定 profile；Agent 任务及其图片、审核、日志和导出 SHALL 绑定原 Session，不能仅凭 opaque ID 授权。profile-library 与 session-run 资产 SHALL 分开关联，转入 library 要求人类明确保存。每 profile SHALL 只有一个本插件 writer，写入使用 revision/operationId 和最终 manifest 提交，不假设跨记录事务。

#### Scenario: R2a Refuse cross-owner access
- **WHEN** 另一 profile 或 Session 获得 runId、imageVersionId 或 exportId 并请求读取/取消/下载
- **THEN** 系统返回 owner-denied 且不泄露内容，资源预览不能绕过同一检查

#### Scenario: R2b Save a Session result as a library sample
- **WHEN** 用户通过所属 Session 的授权界面明确加入样例库
- **THEN** 创建新的 profile-library 关联并保持原 Session 记录权限，其他 Session 不因共享 blob 获得原任务访问权

#### Scenario: R2c Reject another writer
- **WHEN** 同一 profile 的第二个 Host 尝试挂载可写插件
- **THEN** 它报告占用而不打开第二套写缓存或覆盖数据，原 writer 正常卸载后才可接管

### Requirement: R3 Durable run lifecycle and honest restart

Run 状态、stage、outcome、attempt 和进程内 jobId SHALL 分开持久保存。启动、暂停、恢复、取消及终态 SHALL 遵守 data-model；关闭页面不取消。重启 SHALL 将活动任务标为 interrupted，显式恢复使用原 RunSpec 和检查点，新建 attempt；已提交结果不重复执行，未确认外部结果保留 outcome-unknown 与配额消耗。

#### Scenario: R3a Pause and resume after resource release
- **WHEN** 用户暂停活动任务后再恢复
- **THEN** 暂停先停止准入并排空在途写入，返回持久检查点；恢复从下一未完成步骤运行且固定标准不变

#### Scenario: R3b Restart after an uncommitted external response
- **WHEN** 供应商已收到请求而 Host 在结果提交前退出
- **THEN** 恢复显示 interrupted/outcome-unknown，保留已占配额并提示可能重复计费，不宣称原调用从未发生

#### Scenario: R3c Refuse a changed dependency during resume
- **WHEN** 原配置 revision、资产或合法 continuation 已不可用
- **THEN** 恢复明确停止并给出原因，不能以当前默认模型或首屏查询替换原步骤

#### Scenario: R3d Cancel without late success
- **WHEN** 用户取消、Session 被停止或插件停用时仍有在途响应
- **THEN** 系统停止准入、排空和提交取消状态，取消确认后响应不得新增成功项，已提交成果保持可读

### Requirement: R4 Bounded requests and structured failures

部署可变限额 SHALL 由 Config 校验并在 resolve 步骤进入 RunSpec，所有外部尝试含重试先预留配额。失败 SHALL 使用一致 code/stage/retryable/safeMessage/suggestedAction，非法输入、缺引用和版本冲突不得自动重试；可重试读取只在次数、时间和调用预算内执行。费用未知 SHALL 明示，不冒充可强制执行的金额上限。

#### Scenario: R4a Reject before starting a job
- **WHEN** 输入无效、服务能力不支持多图审核或依赖缺失
- **THEN** 系统返回明确错误，不留下未受控 job 或外部请求

#### Scenario: R4b Retry within shared budgets
- **WHEN** 某请求遇到允许重试的超时/限流，同时其他 worker 在运行
- **THEN** 每次重试重新占用同一预算且遵守并发上限，不能靠重试绕过配额

#### Scenario: R4c Keep technical and visual outcomes distinct
- **WHEN** 单图视觉解析失败，而另一张图正常得到拒绝
- **THEN** 两种结果分别计为技术失败与审美拒绝，分母和可操作原因可检查，不用统一 reject 掩盖错误

### Requirement: R5 Safe media and reconstructable model input

系统 SHALL 校验受允许的请求目标、DNS、每次重定向、下载字节/MIME/解码像素及资源权限，不转发 API 凭据到媒体 CDN。仅部署明确允许的固定本地视觉 origin 可例外。模型看到的规则、参考图/成图、模型/提示词版本及实际输出 SHALL 保存在可追溯辅助请求记录；主 Agent 使用既有 tool 日志和呈现元数据。记录和错误 SHALL 不含密钥、认证头、签名媒体 URL 或原始上游敏感错误。

#### Scenario: R5a Reject a redirected private destination
- **WHEN** 媒体 URL 重定向或 DNS 解析到未授权私网/回环地址
- **THEN** 下载在取得目标内容前拒绝，API 凭据没有被转发，错误只给安全原因

#### Scenario: R5b Verify a stored request bundle
- **WHEN** 用户审计某次原图或成图审核
- **THEN** 可取得实际使用的规则、图片版本及摘要和输出校验结果，缺资源明确失败，不用后来样例重建；供应商未固定模型版本时明确重放限制

#### Scenario: R5c Contain malformed image data and prompt-like text
- **WHEN** 响应 MIME 与字节不符、解码像素超限，或图片/说明包含要求改变规则的指令
- **THEN** 非法媒体拒绝并不公开临时文件；合法图片中的文字仅作内容，不能修改 RunSpec、执行脚本或更改 required 规则

### Requirement: R6 Accessible workbench and bounded Agent tools

Client SHALL 提供风格、样例、找图与裁图、数据与评估工作区，复用项目 locale、主题和组件，覆盖分页、窄屏、键盘、焦点恢复、进度、空态和失败态。Agent SHALL 只获得设计声明的读/启动/建议/导出工具，发布、默认切换、人工确认、划分确认及 Skill 启用仅由 Client 执行。长任务 SHALL 返回稳定 runId/jobId 和安全进度，而不是阻塞等待整批完成。

#### Scenario: R6a Continue viewing while progress updates
- **WHEN** 用户筛选报告、打开图片或切换窄窗口，后台任务持续更新
- **THEN** 当前筛选/选择保持，列表可分页和键盘操作，错误/取消状态在所属区域清晰显示

#### Scenario: R6b Expose only authorized Agent operations
- **WHEN** Agent 读取风格、启动任务并提交反馈建议
- **THEN** 使用 Host 同一业务与权限检查，返回安全引用；不存在将建议直接确认为人工反馈或发布风格的 Agent 工具

#### Scenario: R6c Distinguish missing capability from empty data
- **WHEN** 用户打开未配置接口、没有候选或已失败的任务
- **THEN** 界面分别显示配置引导、真实空结果和可恢复错误，不能全部显示“暂无图片”
