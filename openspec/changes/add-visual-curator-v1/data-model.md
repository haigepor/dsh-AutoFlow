# 第一版数据模型

本文定义拟实现的记录、有效性与提交关系；[design.md](design.md) 定义处理流程。所有示例名是业务字段，尚未成为已发布 API。

## 共同规则

- 每条持久记录具有 `schemaVersion: 1`、所属 `profileId`、有类型区分的 opaque ID 和 UTC 时间；对外 ID 采用项目 branded ID 类型。跨 profile 引用拒绝，时间不作为唯一排序或并发依据。
- `revision` 是可编辑 aggregate 的递增修订号；`releaseNumber` 是单风格发布顺序；`schemaVersion` 是数据编码版本，三者不能互换。
- `digest` 是固定序列化和算法版本下的内容摘要；资产字节摘要、规则摘要、请求摘要分别命名，不能只比较可变路径。
- optional 表示没有该事实；`unknown` 表示实际检查后仍无法判断；`not-applicable` 表示条件不适用，不得替换为零分或通过。
- Client/工具 JSON、外部 API、模型输出及磁盘记录在所属解析入口校验；同进程经过类型校验的数据不重复做敌对输入防御。
- 业务历史通过不可变记录及有效头表达。只归档，不级联删除第一版数据；文件缺失、摘要不符和不支持版本报明确错误，不伪造历史。

## 1. Asset 与 ImageVersion

| 记录/字段 | 定义及约束 |
| --- | --- |
| `Asset.assetId`、`familyId` | 稳定逻辑图片和同源/连拍分组；family 调整需重新生成 split manifest |
| `Asset.source` | `local-import` 或 `provider`；保存 providerId、accountIdentity、providerAssetId、非敏感出处和取得时间，不存密钥或短期签名 URL |
| `Asset.access` | profile-library 或 session-run+sessionId，所有预览/派生/导出沿用来源授权；显式保存到 library 创建独立关联，不拓宽原 Session 记录权限 |
| `Asset.originalBlob` | 原文件摘要、字节数、MIME、私有存储引用；本地文件复制后再确认导入成功，不能只引用可能被覆盖的用户路径 |
| `Asset.exportPermission` | `references-only` 或用户明确确认的 `bytes-allowed`，记录确认来源；不从网页可见或搜索成功推断训练/再分发权限 |
| `Asset.groupingStatus` | `unreviewed`、`confirmed`；精确重复自动同组，近似/连拍只给建议，未确认不得声明独立评估 |
| `ImageVersion.imageVersionId`、`parentImageVersionId` | 原图规范化版、分析预览或裁剪派生版；父引用构成无环图，不覆盖父文件 |
| `ImageVersion.kind` | `normalized`、`preview`、`crop`；每条引用具体字节摘要，支持审核指向实际见到的版本 |
| `ImageVersion.geometry` | 已应用 EXIF 方向的 width/height、色彩空间和源到规范化版变换；处理器及处理版本一并保存 |
| `ImageVersion.processing` | 父图、缩放、裁剪区域、编码、输出尺寸和 recipe 摘要；预览不能充当原图像素证明 |

同字节只复用 blob，不合并不同来源归属或样例意图。来源没有可取得原图时，只保存明确取得的 preview，`originalBlob` 缺失并标为不可用于未经验证的最终输出。

## 2. Reference 与 Observation

| 字段 | 定义及约束 |
| --- | --- |
| `referenceId`、`styleId`、`imageVersionId` | 样例关联特定风格和实际图片版本 |
| `role` | `positive`、`negative`、`undecided`；模型推荐角色不视为用户确认 |
| `intent` | `overall` 或按维度选择；维度为 color、lighting、texture、subject、composition、density、depth 等受版本管理的键 |
| `dimensionJudgments` | 投影同一上下文的有效 HumanFeedback 头，只包含明确确认维度；整体喜欢不扩写为全部维度通过，不另存独立标签真相 |
| `context` | 可选题材条件和 usageRevisionId，说明意图适用范围 |
| `confirmedBy`、`confirmedAt` | 由 Host 根据 Client 调用上下文确定；未确认时缺失 |
| `Observation.measured` | 文件/像素可计算事实，保存测量方法及版本 |
| `Observation.inferred` | 模型观察、粗略比例、证据图片/区域、uncertain 字段与 requestId |
| `Observation.corrections` | 指向纠正事实的反馈，不覆盖原模型输出；用户事实纠正和偏好判断分别记录 |

## 3. Style、Draft、Release 与 Rule

| 记录/字段 | 定义及约束 |
| --- | --- |
| `Style` | styleId、名称、归档状态及 aggregate manifest；拥有 draftId、revision、committedReleaseIds、defaultReleaseId、nextReleaseNumber |
| `StyleDraft` | draftId、baseReleaseId、revision、`editing/ready`、候选规则、纳入的 reference 快照、反馈引用及未解决冲突 |
| `StyleCandidate` | candidateSnapshotId、draftId/draftRevision、规则/样例/recipe 快照及 contentDigest；在发布前可独立评估，不引用未提交的 release |
| `Rule.ruleId`、`dimension` | 可追踪规则和视觉维度；同规则修订保留来源关联 |
| `Rule.statement`、`condition` | 用户可理解的要求，以及受限结构化题材/用途适用条件；不执行条件脚本 |
| `Rule.strength`、`stage` | `required/preferred/reference-only`；`source/final`，同一意图跨阶段需分别声明 |
| `Rule.check` | 程序可测约束或视觉判断项；数值包含单位/范围/容差定义，模型估计不能伪装确定性测量 |
| `Rule.exceptions`、`supportRefs`、`counterRefs` | 条件例外和实际样例版本引用，均在 release 内固定 |
| `Rule.confirmation` | `suggested/confirmed`、确认人、时间；required 发布前必须 confirmed |
| `StyleRelease` | releaseId、styleId、releaseNumber、baseReleaseId、candidateSnapshotId/draftRevision、规则/样例完整快照及摘要、evaluationRecipeId、changeSummary、创建/确认人 |
| `StyleRelease.validation` | `provisional/evaluated`、evaluationIds、样本数量和已知限制；质量结论单独存 assessment，不从 evaluated 推断通过率 |

defaultReleaseId 允许为空；空值发起任务时要求显式指定 release，不能退回草稿。release 内引用的全部依赖必须已持久提交且摘要相符。归档风格不允许新任务选用，但保留旧任务读取和导出引用；默认回退不修改 release 内容。

## 4. UsagePreset 与 EvaluationRecipe

| 记录/字段 | 定义及约束 |
| --- | --- |
| `UsagePreset`、`UsageRevision` | presetId 和 currentRevisionId 分离；revision 内容不可变，每次改变比例、像素或安全区产生新 revision |
| `UsageRevision.output` | 约分后的正整数 aspectP/aspectQ、targetWidth/targetHeight、acceptedFormats；输出像素必须满足比例，第一版 allowUpscale 固定 false |
| `UsageRevision.safeRegions` | 成图归一化 x/y/width/height、干扰限制和 required/preferred 强度，矩形必须位于 `[0,1]` |
| `UsageRevision.protectedContent` | 必须保留的主体/背景关系描述及允许例外；模型无法确认时复核 |
| `EvaluationRecipe` | recipeId、视觉 provider 配置 revision、模型名/供应商版本声明、提示词与输出 schema 版本、预处理版本、样例选择策略、评分量表/权重及 unknown 处理 |
| `ReviewBundle` | 具体 requestId 对应的规则、usage、题材、按序 imageVersionId/摘要、实际发送的参考图和说明；由 RunSpec 固定依赖生成 |

有限的偏好量表、required 决策及同分规则必须在 recipe 内明确。模型自报 confidence 原样标识为未校准估计，不作为已校准概率；recipe 不得用 confidence 替代 required 项。

## 5. HumanFeedback、FeedbackThread 与 Suggestion

| 字段 | 定义及约束 |
| --- | --- |
| `feedbackId`、`threadId` | 不可变反馈与同一判定上下文的修订链 |
| `subject` | tagged 目标：单图 imageVersionId、同题材图片比较的左右版本，或 CropCandidate/人工 crop 版本；不能仅绑定 assetId |
| `context` | styleId、releaseId 或 draftId+draftRevision、usageRevisionId、可选 runId/assessmentId、taskBriefDigest；显式声明未使用用途的情况 |
| `kind` | `style-verdict`、`dimension-verdict`、`task-relevance`、`usage-fit`、`pairwise-preference`、`crop-confirmation`、`observation-correction`、`rule-suggestion` |
| `value` | 按 kind 区分：accept/reject/unknown；relevant/irrelevant/not-needed；left/right/tie/neither/unknown；confirmed/not-confirmed；纠正项为字段键及 correctedValue，规则建议为拟改规则和条件，禁止混用 |
| `dimensions`、`reasonCodes`、`comment` | 被评价维度、结构化原因及可选文本；没选维度不补标签 |
| `scope` | `task-only` 或 `style-candidate`；默认 task-only，跨用途迁移不自动成立 |
| `labelEligibility` | `none` 或 `confirmed-candidate`；后者仍需作用范围与发布/数据集筛选，不能直接改变 release |
| `actor` | Host 派生的 authenticated-human 身份及确认方式；Client 不能自报 actor，Agent 建议写 Suggestion |
| `viewEvidence` | 用户看到的图片版本、原/预览/裁后类型；程序记录确认操作，不能声称用户查看了未加载原图 |
| `supersedesFeedbackId` | 首次为空；修订必须匹配当前线程头，跨目标或上下文替代被拒绝 |
| `operationId`、`createdAt` | 幂等提交及时间；相同 operationId+请求摘要返回原结果 |
| `FeedbackThread.headFeedbackId`、`revision` | 最后提交的有效头；线程由 subject、context、kind 和评价维度确定，历史只沿 committed head 的链读取 |
| `Suggestion` | 模型/Agent 的建议、上下文、模型来源及 `pending/accepted/dismissed`；accepted 需要独立的人类确认记录，不改写作者来源 |

`task-relevance=not-needed/irrelevant` 不成为风格负例，`unknown` 不成为正负监督。导出比较记录需比较上下文一致；裁剪拖动无 confirmed 记录时 labelEligibility 为 none。旧上下文反馈迁移到新草稿时保留原引用，并由用户确认适用性；新标准没有追溯改写旧标签。

## 6. RunSpec、Run、Attempt 与 Checkpoint

| 记录/字段 | 定义及约束 |
| --- | --- |
| `RunSpec` | specId、类型 search/crop/analyze/evaluate/export、明确 release 或分析/评估用的 candidateSnapshot/draftRevision、usageRevision、taskBrief、source/vision 配置 revision、ReviewBundle 策略、预算及所有依赖摘要；正式搜图/裁图不能使用草稿或 candidate |
| `RunSpec.budgets` | targetCount、maxSearchPages、maxCandidates、maxVisionCalls、maxDownloadBytes、maxCropCandidatesPerImage、maxConcurrentRequests、maxRetryAttempts、deadline；按任务类型校验必需值，不相关项不伪造 |
| `Run.owner` | `profile` 或 `session` tagged 值；session 包含 sessionId，不能仅凭 runId 授权读取 |
| `Run.status` | `created/running/pausing/paused/interrupted/cancelling/cancelled/completed/failed`，与业务 stage 分开 |
| `Run.stage` | planning/retrieving/screening/cropping/reviewing/finalizing，阶段为空时必须尚未启动 |
| `Run.outcome` | completed 时为 target-met/source-exhausted/budget-exhausted/partial-failure；failed/cancelled 另有安全原因，保留已提交结果但不冒充满足数量；partial-failure 表示部分查询失败导致目标不足，不等同来源正常耗尽 |
| `Run.counts` | retrievedUnique、sourceReviewed、cropGenerated、finalPassed、rejected、needsReview、technicalFailed、pending，按唯一对象和阶段定义，不能把各阶段失败累加成图片总数 |
| `Run.attempts` | 进程执行段；每次恢复有独立 attemptId 和 jobId，原 spec 不变 |
| `Attempt.requests` | 外部尝试的 reserved/committed/outcome-unknown 预算账本、请求摘要、返回及校验引用，不保存认证信息 |
| `Checkpoint` | checkpointId、Run revision、已提交页面、逐对象进度、合法 nextCursor、已存结果引用、预算账本及下一待做步骤 |

| 事件 | 状态转换与保证 |
| --- | --- |
| 启动 | created → running；输入预检失败不产生 job 和外部请求 |
| 暂停 | running → pausing → paused，先停止准入并排空在途写入再确认检查点 |
| 重启发现未收尾任务 | running/pausing → interrupted；cancelling 收敛 cancelled，不能显示仍在运行 |
| 恢复 | paused/interrupted → running，新 attempt 引用原 spec 和有效检查点；失败保持可见错误 |
| 取消 | 活动状态 → cancelling → cancelled；停止新准入，已提交结果保留，取消确认后不能新增成功结果 |
| 自然结束 | running → completed 并提供 outcome；没有候选且来源正常耗尽也完成，不伪造零失败率 |
| 无法继续 | 活动状态 → failed 并保留已提交结果和失败阶段 |

暂停不承诺中断供应商已经开始的计费；重启对无法确认的尝试保留配额消耗。恢复时来源或视觉配置 revision 不可用、资产不完整或 cursor 失效，则停止并说明，用户显式建立新任务才能换配置或重搜。

RunSpec 使用 tagged 任务输入：analyze 固定 draftRevision、样例版本和视觉 recipe；search 固定 release、usage、source、taskBrief；crop 固定父图版本、release、usage、保护内容；evaluate 固定两个 release/candidate、split、usage 和计分方法；export 固定导出种类、有效反馈头和 split。仅需要远程视觉的任务要求 vision 配置，只有 search 要求 source；所有类型都带各自适用预算和完整摘要，离线导出不能因未配置搜索接口而失败。

完成原因按事实选择：先满足目标为 target-met；先用尽硬预算为 budget-exhausted；全部查询正常结束但不足为 source-exhausted；存在阻断查询错误且其他查询已结束、不满足前述条件为 partial-failure；所有来源调用失败且无法继续为 failed。各结果都保留技术警告和已提交成果。

## 7. SearchPage、Assessment、CropCandidate 与 FinalSelection

| 记录/字段 | 定义及约束 |
| --- | --- |
| `SearchPage` | runId、queryId、精确 query/language/filter、pageAttemptId、输入/输出 cursor、候选 providerAssetId 集合、实际页量和协议状态 |
| `Assessment` | assessmentId、imageVersionId、stage source/final、releaseId、recipeId、ReviewBundleId、分项结果、证据及技术状态 |
| `Assessment.verdict` | pass/reject/needs-review；技术失败时没有审美 verdict，技术状态单独是 failed |
| `Assessment.ruleResults` | ruleId、satisfied/violated/unknown/not-applicable、measured/inferred、人可检查的理由、可选区域；不接受模型直接覆盖程序几何结果 |
| `Assessment.cropPotential` | direct/crop-candidate/infeasible/unknown，仅描述当前用途下可行性，不等于最终通过 |
| `CropCandidate` | candidateId、parentImageVersionId、runId、release/usage/recipe 引用、requestedRect、effectivePixelRect、geometryResult、derivedImageVersionId 和 finalAssessmentId |
| `CropCandidate.origin` | model/program/human；human 不表示已确认，另需 confirmation feedback |
| `FinalSelection` | 通过成图版本、所依据 assessment、排名及明确人工警告；只有程序检查通过且 required 无失败/阻塞 unknown 才是 auto-qualified |

归一化区域为 `(x,y,width,height)`，均有限且 x/y ≥ 0、width/height > 0、x+width/y+height ≤ 1。转换到已定向 W×H 后，原始边界用 floor 左上、ceil 右下；在该取整后的建议区域内取最大的整数 p:q 窗口，k 为建议宽/p 与建议高/q 较小值的 floor，左右/上下余量各取 floor 一半作为起点偏移，余下一个像素留在右/下。保存确定算法版本及实际区域；k 小于 1 或实际区域小于目标任一边则拒绝。几何合格至少要求窗口未越界、正面积、输出等于用途目标且无放大；算法不得把越界请求静默裁成合法请求。

## 8. SplitManifest、EvaluationReport 与 ExportSnapshot

| 记录/字段 | 定义及约束 |
| --- | --- |
| `SplitManifest` | splitId、revisionDigest、每个 confirmed family 的 learning/development/holdout 分配、确认人和时间、揭示/使用记录；修改即产生新 manifest |
| `EvaluationReport` | reportId、两个 tagged release/candidate 引用及 contentDigest、固定数据/用途/预算/审核器配置、每图记录、原始计数/分母、未知/失败、成本估算状态和人工判断；发布只能引用相同 candidate 内容的报告 |
| `EvaluationReport.metrics` | 人工正负标签上的接受/漏选/误收、全样本复核/技术失败、已复核裁图的破坏率/接受率、调用与耗时；无分母显示 unavailable |
| `ExportSnapshot` | exportId、formatVersion: 1、kind、release/usage/split、有效 feedbackId 及请求时的头、asset/imageVersion 摘要、创建人、references/with-bytes 选择、文件及 checksum 清单 |
| `OperationReceipt` | operationId、请求摘要、aggregate、提交引用；返回已完成结果或明确冲突，不因重试重复创建 release/feedback/export |

导出格式：风格包含 manifest、规则、样例及可选 bytes；classification 行含 imageVersion、style/release、维度/整体标签与 human feedbackId；preference 行含两边版本、比较上下文和选择；crop 行含父图、usage、选定像素区域、实际派生版本和确认反馈；Skill 为 Markdown 和资源清单。每行有 schemaVersion、familyId、split 和可追溯摘要；不混入 holdout 训练行，不生成权重文件或未经验证的训练框架配置。

## 9. 操作输入、输出和失败

| 操作 | 必需输入 | 成功输出 |
| --- | --- | --- |
| 导入/分析 | profile、已授权上传/文件选择引用、样例意图、draftId+expectedRevision | 每项 asset/imageVersion/reference 或具体错误；分析返回 runId |
| 确认反馈 | 目标版本、完整 context、kind/value/scope、expectedHead、operationId | feedbackId、thread revision、有效来源 |
| 发布 | draftId、expectedRevision、确认引用、operationId | committed releaseId/releaseNumber；不改变默认 |
| 默认切换 | styleId、releaseId、expectedRevision、operationId | 当前 defaultReleaseId 和新 revision |
| 搜索 | style release 明确值或可解析默认、usageRevisionId、taskBrief、sourceId、预算 | runId、specDigest、jobId 和初始状态 |
| 裁图 | imageVersionId、release、usage、protectedContent、预算 | runId、specDigest、jobId；候选异步保存 |
| 查询任务/结果 | runId、所属 Session/profile 授权、合法 pageToken | status/stage/outcome、计数、分页结果和安全预览引用 |
| 导出 | kind、release/usage/split、记录筛选、references/with-bytes、operationId | export runId；完成后产物引用和 checksum |

错误字段统一为 code、stage、retryable、safeMessage、suggestedAction、attemptId（发生尝试时）。核心错误包括 invalid-input、constraint-conflict、revision-conflict、reference-unavailable、configuration-required、capability-unavailable、source-protocol-error、source-continuation-invalid、vision-invalid-output、budget-exhausted、storage-commit-failed、cancelled 和 owner-denied。预算自然结束使用 outcome，只有启动所需预算为零等无效请求才返回参数错误。

图片来源 endpoint 与字段映射、模型端点和凭据引用从部署 Config 解析；不把它们放进风格可自由编辑字段。每个输出 URL 都由 Host 资源授权层生成，跨边界记录只携带 opaque ID 及安全描述。
