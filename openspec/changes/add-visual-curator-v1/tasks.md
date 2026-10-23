## 1. 独立包与领域提交基础

- [x] 1.1 建立独立 bundle、Host/Client leaf 入口、locale 与 feature 声明，仅登记本包必需 workspace/build 项；验证 exports、无应用 bin、按后续随包集成要求区分新旧 profile，并保持 AFP diff 为空。（R1）
- [x] 1.2 按 data-model 定义版本化持久 schema、branded ID、跨 profile 引用校验与公开输入/结果；验证无效 tagged 值、未知 schema 和错误归属在解析入口拒绝。（S1–S6、F1–F4、R2）
- [x] 1.3 复用 storage-domain，实现单 profile writer 生命周期、aggregate revision 串行提交和不可变依赖后置 manifest；注入写入失败验证孤立依赖不可见及旧默认/反馈头保留。（S5、F3、R2）
- [x] 1.4 实现 operationId 请求摘要与提交恢复，覆盖重复成功、相同 ID 不同请求、并发旧 revision 和重启恢复；不得以覆盖历史消除冲突。（S5、F3、E3）

## 2. 图片资产与外部适配

- [x] 2.1 实现上传/授权目录选择后的图片导入、格式/字节/像素限制、原文件保留、方向规范化及精确去重；验证混合批次部分失败、重复 blob 独立关联及源文件后改不影响已保存图片。（S1、C1）
- [x] 2.2 实现带摘要和父引用的 ImageVersion、私有预览资源、profile-library/session-run 关联及显式保存到样例库；验证跨 Session/profile 访问、临时文件和缺损资产均被拒绝。（R2、C5、S6）
- [x] 2.3 实现 HTTP JSON source 的配置校验、受限请求字段/JSON Pointer 映射、首屏/真实游标、来源 ID 与可选媒体 lookup；fixture 覆盖 GET/POST、空/重复 cursor、坏字段及原图不可用。（Q1、Q3、Q7）
- [x] 2.4 实现来源/媒体/视觉的目标、DNS/重定向、凭据发送范围与下载解码限制；验证私网跳转、域名变更、MIME 不符、超像素及敏感上游错误不泄露。（R5）
- [x] 2.5 实现多图视觉适配的 analyze/review/propose-crop 输入、严格模型结果解析、能力预检及安全错误；keyless fixture 覆盖缺多图能力、坏 JSON、unknown、指令式图片文字和重试分类。（S2、Q4、R4、R5）

## 3. 人工反馈与有效标签

- [x] 3.1 实现 Host 派生人工来源、Reference 确认反馈投影、Suggestion 独立保存和反馈输入校验；验证 Agent 伪造 human、跨目标上下文及未知 kind/value 无法落成人工标签。（F1、F2）
- [x] 3.2 实现 task-only/style-candidate、分维度 accept/reject、题材/用途/本次不需要及事实纠正；覆盖色彩正例构图反例与 task-only 不污染长期风格。（F2）
- [x] 3.3 实现 FeedbackThread 当前头、改判 supersedes 和历史查询；验证同头并发只成功一次、写头前故障不生效、重试幂等及旧快照不变。（F3）
- [x] 3.4 实现比较上下文、平局/均不合适/unknown 与裁剪完成/纳入样例确认；验证拖动后取消、浏览/下载/普通批量接受不生成监督。（F4）
- [x] 3.5 实现分歧/unknown/新类型复核队列及普通结果抽检，保留队列依据；验证规则建议未确认前不影响 release 或默认任务。（F5）

## 4. 风格草稿、用途与发布

- [x] 4.1 实现逐图测量/模型观察、参考维度及规则归纳，保存支持/反例、条件、例外与 source/final；验证估计不伪装测量、元数据不能补像素结论。（S2）
- [x] 4.2 实现草稿修订、required 冲突处理、代表样例选择和 StyleCandidate 固定快照；验证未确认规则、未解决冲突及已变更摘要无法发布。（S2、S3）
- [x] 4.3 实现不可变 UsageRevision 的比例/像素/安全区和 required 规则冲突解析；验证多用途复用同风格、非法比例/像素在外部调用前拒绝。（S4、C1）
- [x] 4.4 实现 releaseNumber 分配、provisional/evaluated、匹配评估绑定及显式默认/回退；验证发布不自动切默认、审核器变化生成新版本和并发发布恢复。（S3、S5、E2）
- [x] 4.5 实现 RunSpec/ReviewBundle 解析与依赖完整性检查；验证任务中改样例/默认后搜索及裁图仍用固定版本，缺失字节不能用最新资源替代。（S6、Q2）

## 5. 持久任务与预算执行

- [x] 5.1 实现类型化 Run/Attempt/Checkpoint、profile/Session owner 及 jobs controller 预检；覆盖启动失败无 job、关闭页面继续和 owner-denied。（R2、R3、R4）
- [x] 5.2 实现所有外部尝试共享的调用/字节/并发/重试/截止时间预留账本；用受控 barrier 验证并发最后额度、取消和重试都不越限，费用未知准确呈现。（Q6、R4）
- [x] 5.3 实现暂停、取消、卸载排空及 late-response 防提交；验证取消确认后没有新成功项、原结果仍可读、Session 停止按原 ownership 收尾。（R1、R3、C5）
- [x] 5.4 实现重启 interrupted、cancelling 收敛、原 spec 恢复、新 attempt 与 outcome-unknown 记录；注入页面提交前后退出和过期 cursor，验证已提交不重做且不静默换配置。（Q7、R3）
- [x] 5.5 保存可重建辅助模型输入/输出校验与安全诊断，接入既有 tool/presentation 记录；验证原图/裁后 bundle、外部版本未知标记以及日志和导出无凭据/签名 URL。（R5）

## 6. 搜索完整流程

- [x] 6.1 串联固定 RunSpec、QueryPlan、首屏/分页、候选持久化、去重及媒体取得；fixture 验证同图跨查询只算一次、来源协议错误停止和 preview 不冒充原图。（Q1–Q3）
- [x] 6.2 实现逐规则 source 审核、unknown/技术失败区分、source 与 final 条件分离及 crop-potential；覆盖标题匹配画面不符和横图保留裁剪潜力。（Q4）
- [x] 6.3 实现 required 优先、固定偏好权重/同分稳定排序、已合格 distinct 成图选择及预算内补图；验证高偏好不能抵消 required 失败。（Q5、Q6）
- [x] 6.4 接通裁剪子流程并保存原/成图分离结果；完成 target-met、source-exhausted、budget-exhausted、partial-failure 与来源全失败收尾，覆盖目标 10 张只得 6 张、部分查询失败而不放宽标准。（Q5、Q6）

## 7. 裁剪完整流程

- [x] 7.1 实现规范化坐标解析、requested/effective 区域、精确整数比例与无放大几何；覆盖 EXIF 方向、边界、非有限数、负面积及输出不足。（C1）
- [x] 7.2 实现必要主体/背景/安全区可行性、unknown 分流和有区别的有限候选；验证横转竖可行及两个必要主体无法同时容纳的拒绝。（C2）
- [x] 7.3 使用 sharp 生成不可变成图，保存处理 recipe/摘要并以固定风格做真实成图复核；验证调整后必须复核、原图通过而裁后全失败不计合格。（C3、C5）
- [x] 7.4 实现重复区域去重、每图和总预算停止及候选排序；覆盖持续无效建议不能无限循环。（C3、Q6）
- [x] 7.5 实现人工调整预览、明确完成、新派生复核与独立纳入样例操作；覆盖警告版本只标 human-selected、非法几何不能交付、取消不覆盖旧选择。（C4、F4）

## 8. 工作台与 Agent 集成

- [ ] 8.1 实现风格页的规则/支持图/冲突、candidate、版本及默认操作，样例页的导入、维度、比较和反馈修订；复用本地主题和组件，不改全局样式。（R6、S1–S5、F1–F5）
- [ ] 8.2 实现找图/裁图的明确版本表单、分页结果、原/成图对照、任务进度及暂停/恢复/取消；保留后台更新中的筛选、选择和打开预览。（R6、Q1–Q7、C1–C5）
- [x] 8.3 注册设计声明的八个 Agent 工具与 Remote 权限，长操作先返回 runId/jobId；验证 Client/工具共用业务服务，工具不提供人工确认/发布/默认切换。（R6、F1）
- [ ] 8.4 完成 typed locale、空/错/缺配置状态、键盘、焦点恢复和窄屏布局；用真实浏览器检查而不以静态 markup 代替运行证据。（R6）

## 9. 数据划分、评估与导出

- [x] 9.1 实现 family 分组提示/人工确认、不可变 SplitManifest 和 holdout 使用记录；覆盖同源/裁剪跨集拒绝、未确认近似不能宣称独立和揭示后新 manifest。（E1）
- [x] 9.2 实现 release/candidate 同输入对比、逐图记录及 acceptance 定义的指标/分母；覆盖无标签 unavailable、技术失败、unknown 和改善/退步并存且不自动切默认。（E2）
- [x] 9.3 实现固定反馈头和数据选择的 ExportSnapshot、分类/偏好/裁剪 JSONL 与资源清单；覆盖改判后新旧快照、无资格标签排除和 training 不含 holdout。（E3、E4）
- [x] 9.4 实现 references-only 默认、with-bytes 授权/完整性检查、checksum 和幂等下载；验证未授权/缺损资源不生成“完整包”。（E3、E4）
- [ ] 9.5 生成固定版本 Skill Markdown 和资源访问说明，提供预览下载；验证不写 Home 指令、不自动启用、不宣称模型已训练，并完成数据/评估 UI。（E5、R6）

## 10. 闭环验证与交付

- [ ] 10.1 逐项完成 acceptance.md 的 S/F/Q/C/R/E 正向及拒绝场景；为状态、并发和故障使用可控 fixture，不用计时等待制造稳定性，记录每项实际命令和结果。（全部要求）
- [x] 10.2 新增通过真实 Agent 循环的 keyless recorded-session 场景，覆盖固定风格搜索、坏模型输出、裁后拒绝、建议不冒充人工、owner 拒绝及停用工具消失；缺少的 harness 支持在本包允许范围内补齐，其他 fixture 保持 owner-local。（R1、R5、R6、Q4、C3）
- [ ] 10.3 运行本包单测/类型/构建检查、独立 bundle 打包检查和 built-profile 工具 smoke；验证所有 exports/Client/locale/资产存在，只有 dsh profile 启动应用。完成最新 build:artifacts 后的 build:check，并按实际影响选择根级其他检查，不默认跑全套。（R1）
- [ ] 10.4 在带测试目录选择 overlay 的 Web profile 运行浏览器闭环，覆盖导入、校准发布、反馈改判、搜图裁图、暂停/恢复、分集导出及手机宽度；收集请求/控制台错误与可审阅截图。（T1–T4）
- [ ] 10.5 提供真实来源/视觉部署输入后执行受预算约束的真实接口 smoke 和用户样例试用；分开记录功能通过与审美/费用尚未验证，未取得输入不得把 fixture 写成真实验证。（T1–T4）
- [x] 10.6 补包内 README/JSDoc 及对应双语文档，说明版本、预算、失败、导出和启用范围；运行相关文档、编码及 diff 检查，审查最小改动并说明停用/默认回退路径。本 checklist 只在证据存在时勾选。（全部要求）

## 11. 随包集成

- [x] 11.1 按用户后续确认调整 R1 与安装设计；CLI 声明生产依赖，Web/Desktop 新 profile 默认启用，已有 profile 的选择和 patch 不重写，headless/SDK/ACP 默认列表不变。（R1c、R1d）
- [x] 11.2 在 Desktop 自定义包打包阶段包含视觉策展 tarball；验证生产闭包包含本包、缺少 tarball 时明确失败，外部 sharp 依赖由正常包安装解析。（R1c）
- [ ] 11.3 新增真实 Web 组合的 keyless 浏览器快照；验证无 profile 副本时可启用，未配接口可创建风格，停用后入口消失、刷新保留停用、再启用数据仍在，AFP 工作台可用。（R1a–R1d）
- [ ] 11.4 完成最新 build:artifacts/build:check、AFP 回归与文件摘要、双语文档/编码和独立包更新；记录已运行旧 Host 的重启要求，不将随包链路验证写成已发布桌面安装包。（R1）

## 本轮执行状态

证据见 [verification.md](verification.md) 和包内 [验收映射](../../../custom-plugins/workspace/dsh-plugin-visual-curator/tests/acceptance-matrix.md)。50/52 是移除旧工作台前的历史状态。用户随后要求从原生插件详情重新搭建页面；旧工作台已移除，相关 UI 与交付任务重新打开，以当前勾选为准。十二项原生功能已登记，三个页面入口默认关闭且仅显示待设计提示；本次页面重建不沿用旧 UI 的浏览器通过结论。10.1 保留未逐场景执行的组合验收，10.5 真实接口延期；不将结构校验或 fixture 写成真实接口验收。
