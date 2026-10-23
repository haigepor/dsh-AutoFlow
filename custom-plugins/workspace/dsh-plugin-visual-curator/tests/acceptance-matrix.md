# 本地验收映射

本表对照 [验收约定](../../../../openspec/changes/add-visual-curator-v1/acceptance.md) 的 34 条要求，列出当前包内测试及仍需补齐的决定性证据。案例名使用测试标题中的可搜索片段；多个单元测试组合只能证明各自断言，不能替代指定端到端场景。本文不勾选实施任务，也不将代码存在、fixture 通过或 OpenSpec 结构校验写成真实接口及审美验收通过。

测试默认使用受控 HTTP/视觉响应及真实 sharp 像素处理。`plugin-agent-loop.test.ts` 使用生产 AgentLoop 和真实 CuratorService，输出由包内预期文件核对；受支持 profile 的 Session 重放、built smoke、浏览器步骤和真实部署记录由主验收记录单独提供。

## 风格与版本

规范：[visual-style-versions](../../../../openspec/changes/add-visual-curator-v1/specs/visual-style-versions/spec.md)。

| 要求与场景 | 当前测试映射 | 未证明的部分 |
| --- | --- | --- |
| S1 · S1a–S1c 导入与维度意图 |[domain.test.ts](domain.test.ts) `projects only selected intent dimensions` 检查色彩标签不扩大；[service.test.ts](service.test.ts) `mixed batch failure preserves good pixels` 检查逐项失败；[media-assets.test.ts](media-assets.test.ts) `reuses exact digest blobs and applies EXIF orientation`、`rejects mismatched MIME` 检查精确去重及动画、像素限制；[浏览器记录](#浏览器与文档检查记录) 已确认 fresh 单图导入。 [acceptance-edge.test.ts](acceptance-edge.test.ts) `the same imported blob keeps independent opposite roles` 验证同 blob 跨风格关系独立。| 未单独执行四种意图与非法文件混在同一批的总调用计数；各自解析及失败路径已有测试。 |
| S2 · S2a–S2b 证据规则草稿 | [media-vision.test.ts](media-vision.test.ts) `analysis separates uncertain observations from unconfirmed rules`、`rejects malformed JSON` 检查估计、unknown、伪测量及图片引用；[domain.test.ts](domain.test.ts) `refuses unconfirmed required rules` 检查未确认规则不能形成 candidate。 | 缺口：冷暖反例冲突经界面修改条件／例外后成功发布，及未解决 conflict 的独立拒绝断言。模型 fixture 不证明真实图片语义识别。 |
| S3 · S3a–S3c 不可变候选与发布 | [domain.test.ts](domain.test.ts) `publishes once without selecting a default` 检查发布幂等、递增编号、旧 release 与过期草稿；[service-edge.test.ts](service-edge.test.ts) `a changed deployment cannot run an old recipe` 检查新旧审核配置独立；[domain-data-workflows.test.ts](domain-data-workflows.test.ts) `replay committed model responses` 案例内比较未发布 candidate；[浏览器记录](#浏览器与文档检查记录) 已确认分析、规则确认、候选发布与另行设默认。 | 缺口：用错误 candidate 内容摘要的 evaluation 发布新候选的定向拒绝案例；不能把普通旧 revision 拒绝等同于评估摘要匹配验证。 |
| S4 · S4a–S4c 用途与默认 |[domain.test.ts](domain.test.ts) `refuses unconfirmed required rules and invalid output ratios`、`publishes once without selecting a default` 检查比例与显式默认；[frozen-review.test.ts](frozen-review.test.ts) `editing references and the default during a blocked search` 检查在途任务固定原版本。 [acceptance-edge.test.ts](acceptance-edge.test.ts) `draft standards and impossible required output rules` 验证 draft 与 measured required 冲突零外呼、零 job。| 尚未单独执行同 release 手机／桌面两任务及默认回退后的新任务组合。 |
| S5 · S5a–S5c manifest、并发和重试 |[domain.test.ts](domain.test.ts) `hides dependencies after a failed manifest and retries exactly once`、`admits only one writer at an expected revision` 检查提交机制；`keeps the previous published list and default after a manifest failure` 检查默认提交失败；`publishes once without selecting a default` 检查 release 只分配一次。 [acceptance-edge.test.ts](acceptance-edge.test.ts) `publication retries after its dependency writes` 验证 release 依赖写完、manifest 失败、重新打开与幂等重试。| 两个实际风格编辑同时提交的专属案例未独立执行；通用 aggregate 并发已验证。 |
| S6 · S6a–S6b 固定审核材料 |[frozen-review.test.ts](frozen-review.test.ts) `editing references and the default during a blocked search keeps its source and crop reviews on the original release` 使用 barrier 在请求中编辑样例、发布及切默认，核对 RunSpec 和 source／crop 归属；[service-edge.test.ts](service-edge.test.ts) `a changed deployment cannot run an old recipe`；[media-vision.test.ts](media-vision.test.ts) `preflights multi-image capability, actual digests` 检查缺损摘要零调用。 [acceptance-edge.test.ts](acceptance-edge.test.ts) `draft standards and impossible required output rules` 拒绝 draft 正式启动且零外呼。| 已有冻结材料、运行中编辑、草稿正式启动拒绝及缺损像素的组合证据。 |

## 人工反馈

规范：[visual-human-feedback](../../../../openspec/changes/add-visual-curator-v1/specs/visual-human-feedback/spec.md)。

| 要求与场景 | 当前测试映射 | 未证明的部分 |
| --- | --- | --- |
| F1 · F1a–F1b 实际查看与作者 |[domain.test.ts](domain.test.ts) `projects only selected intent dimensions and rejects forged human authors` 检查导入确认来源与伪造拒绝；[plugin-agent-loop.test.ts](plugin-agent-loop.test.ts) `a real AgentLoop records fixed-style jobs` 检查建议保留 Agent 作者且不增加人工反馈；[domain.test.ts](domain.test.ts) `exports only explicitly opted-in generated crop confirmations` 拒绝不匹配 crop subject。 实际浏览器载入原图/成图后完成裁剪确认及风格改判，见主验证记录。| 未加载图片的组件禁用状态未单独保存截图；不声称自动验证用户实际注意过画面。 |
| F2 · F2a–F2c 多维和范围 |[domain.test.ts](domain.test.ts) `keeps task relevance out of style supervision` 检查 not-needed 不具风格监督资格；`projects only selected intent dimensions` 检查不扩大维度；[domain-data-workflows.test.ts](domain-data-workflows.test.ts) `replay committed model responses` 检查归纳仅产生待确认建议。 [acceptance-edge.test.ts](acceptance-edge.test.ts) `color acceptance and composition rejection` 验证两维有效头并存、task-only 不进入分类导出。| 尚未单独执行 task-only 事实纠正对规则归纳的组合场景。 |
| F3 · F3a–F3c 追加修订与有效头 | [domain.test.ts](domain.test.ts) `keeps one effective head, history and immutable operation retries` 检查写头失败、旧头可读、修订幂等和过期头拒绝；`freezes feedback heads and checksums` 检查旧导出不变；[service-edge.test.ts](service-edge.test.ts) `an export uses its accepted feedback heads` 检查排队后改判仍使用受理时头。 | 缺口：不同裁图／用途的 expectedHead 替代拒绝，以及真正并发的两个反馈改判；当前案例为先后提交的过期头。 |
| F4 · F4a–F4c 比较与裁剪监督 |[domain.test.ts](domain.test.ts) `exports left, right, tie and neither as distinct preferences while excluding unknown and suggestions` 保留比较值；`exports only explicitly opted-in generated crop confirmations with their actual geometry` 检查父图、区域、学习选择与错误 subject；[media-crop-workflow.test.ts](media-crop-workflow.test.ts) `manual completion bypasses proposals` 检查生成不会冒充人工标签。 浏览器修改归一化坐标后取消，任务数不变；再次生成后独立确认学习选择，crop JSONL 包含真实父图和区域。| 拖动指针取消与填写坐标取消使用同一关闭路径；本轮实际执行填写坐标取消。 |
| F5 · F5a–F5b 复核队列与受控更新 | [frozen-review.test.ts](frozen-review.test.ts) `review queue preserves frozen ordinary sampling` 检查启动 rate=1 后部署改 0 仍抽检、新未确认来源组、人工改判分歧与重复读取相同；`invalid model output enters technical review` 检查技术队列没有伪造拒绝；[domain-data-workflows.test.ts](domain-data-workflows.test.ts) `replay committed model responses` 检查建议不改规则或人类反馈。 | 缺口：重复纠正建议所引用受影响图片的界面检查、unknown 规则的定向队列断言。新来源组仅表示来源分组未确认，不证明语义新类别识别。 |

## 找图

规范：[visual-image-search](../../../../openspec/changes/add-visual-curator-v1/specs/visual-image-search/spec.md)。

| 要求与场景 | 当前测试映射 | 未证明的部分 |
| --- | --- | --- |
| Q1 · Q1a–Q1c 来源与游标 | [media-source.test.ts](media-source.test.ts) `omits initial cursor and uses real returned cursor`、`POST request mappings and escaped JSON Pointers are data-only`、`rejects malformed fields, missing stable identity`；[config.test.ts](config.test.ts) `deployment endpoints reject inline credentials` 检查静态配置目标。 | 缺口：外部真实来源部署的请求记录；本表只证明 fixture 的 GET／POST、缺字段与循环 cursor 行为。 |
| Q2 · Q2a–Q2b 固定搜索参数 |[service.test.ts](service.test.ts) 首个案例和 [plugin-agent-loop.test.ts](plugin-agent-loop.test.ts) 通过配置关键词来源与真实多图 adapter 完成搜索，无向量依赖；[service-edge.test.ts](service-edge.test.ts) `a changed deployment cannot run an old recipe` 检查冲突不建 job。 [acceptance-edge.test.ts](acceptance-edge.test.ts) 验证 draft 与 required 输出冲突拒绝且零网络／任务。| 空默认与其他风格 release 归属的专属外呼计数尚未单独执行。 |
| Q3 · Q3a–Q3b 唯一性与像素 | [search-workflow.test.ts](search-workflow.test.ts) `search uses real pagination, deduplicates bytes without losing independent source associations`、`target count stops after distinct final selections and never counts source-only pass or preview pixels` 检查跨页去重、关联保留、实际成图像素及唯一计数。 | 无新增结构性缺口；真实来源仅有预览、过期原图的部署行为仍需实测。 |
| Q4 · Q4a–Q4c 像素审核 | [media-crop-workflow.test.ts](media-crop-workflow.test.ts) `embedded crop uses the search Run` 保留裁剪路径；[media-vision.test.ts](media-vision.test.ts) `sends actual multi-image pixels`、`rejects malformed JSON` 检查实际图片、strict unknown、技术失败；[media-crop-workflow.test.ts](media-crop-workflow.test.ts) `bad visual output is a saved technical failure`。 | 缺口：标题声称有主体但 fixture 画面判断无法确认的专门搜索案例；模型收到像素及受限提示词不能证明真实模型不会依赖标题。 |
| Q5 · Q5a–Q5c 必要规则与排序 | [runtime.test.ts](runtime.test.ts) `required failures and unknown cannot be averaged away`、`saved assessments have stable deterministic ranking`；[media-crop-workflow.test.ts](media-crop-workflow.test.ts) `source pass cannot replace actual crop review`、`all damaged crops are rejected` 检查真实派生图与最终资格。 | 无新增结构性缺口；真实主体破坏检出率属于人工质量验收。 |
| Q6 · Q6a–Q6c 预算与不足 |[search-workflow.test.ts](search-workflow.test.ts) `reports shortfall`、`a bad-protocol query stops while other queries complete`、`all failed queries fail visibly`、`unknown failed download spends its byte reservation`；[runtime-lifecycle.test.ts](runtime-lifecycle.test.ts) `admits only the remaining attempts under concurrent reservations`；[runtime.test.ts](runtime.test.ts) `last shared vision reservation cannot be spent twice`。 [search-workflow.test.ts](search-workflow.test.ts) `a ten-image target retains exactly six qualified derivatives` 通过真实 RunEngine 得到 budget-exhausted、6 张 distinct 合格、24 次调用及固定摘要。| 与运行中更改默认的组合由 frozen-review 的 barrier 案例单独证明；不是同一次十图运行。 |
| Q7 · Q7a–Q7b 恢复来源 | [search-workflow.test.ts](search-workflow.test.ts) `resume at the candidate limit`、`resume replays a committed source review`；[media-source.test.ts](media-source.test.ts) `refreshes media only by matching stable ID and never restarts unsupported continuation` 检查不能静默重搜。 | 缺口：同一搜索 run 在保存页面后实际重建 Host 并遇到过期 continuation／媒体定位的组合案例；单独恢复与 adapter 拒绝已有覆盖。 |

## 裁图

规范：[visual-smart-crop](../../../../openspec/changes/add-visual-curator-v1/specs/visual-smart-crop/spec.md)。

| 要求与场景 | 当前测试映射 | 未证明的部分 |
| --- | --- | --- |
| C1 · C1a–C1c 坐标与几何 | [media-assets.test.ts](media-assets.test.ts) `applies EXIF orientation`、`resolves the largest exact integer ratio`、`writes actual exact-size crop pixels` 检查定向、1215×2160、NaN／越界／小窗口及真实像素；[media-crop-workflow.test.ts](media-crop-workflow.test.ts) `source pass cannot replace actual crop review` 检查 final 实际图。 | 缺口：带 EXIF 输入贯穿建议区域、requested/effective 记录及最终复核的单一闭环；目前分段覆盖。 |
| C2 · C2a–C2c 可行性与保护 | [media-vision.test.ts](media-vision.test.ts) `crop proposals distinguish impossible/uncertain results` 检查两个主体不可行、unknown 和无效提案；[media-assets.test.ts](media-assets.test.ts) `resolves the largest exact integer ratio` 检查横转竖窗口；[media-crop-workflow.test.ts](media-crop-workflow.test.ts) `all damaged crops are rejected` 检查 unknown 不合格。 | fixture 只证明三态处理；真实单主体、双主体与安全区能否可靠判别仍需部署图片和人工复核。 |
| C3 · C3a–C3c 真实成图与限额 | [media-crop-workflow.test.ts](media-crop-workflow.test.ts) `only the undamaged exact-size derivative is selected` 对两个真实不同裁图审核选优；`all damaged crops are rejected`、`budget exhaustion retains generated candidates`；[media-vision.test.ts](media-vision.test.ts) `reject out-of-bounds or repeated regions` 检查去重与预算。 | 无新增结构性缺口；真实构图偏好不由颜色 fixture 证明。 |
| C4 · C4a–C4c 人工调整与选择 | [media-crop-workflow.test.ts](media-crop-workflow.test.ts) `manual completion bypasses proposals, retains warnings as human selection`、`invalid manual geometry and absent human confirmation`；[service-edge.test.ts](service-edge.test.ts) `manual completion validates exact source pixels before job creation`；[domain.test.ts](domain.test.ts) 明确 opted-in crop 导出案例。 | 缺口：浏览器拖动／数字调整、取消后原已确认选择不变、生成后再确认学习的完整交互记录。 |
| C5 · C5a–C5b lineage 与取消 | [media-assets.test.ts](media-assets.test.ts) `writes actual exact-size crop pixels without replacing parent, rejects changed/missing/path-escaped blobs`；[media-crop-workflow.test.ts](media-crop-workflow.test.ts) `cancellation after derivative commit publishes no late selection`、`a committed auxiliary visual response is replayed`。 | 缺口：临时图片已生成而派生引用尚未提交时注入取消，并从真实资源／导出入口断言临时产物不可读；当前取消点在派生提交之后。 |

## 运行时与界面

规范：[visual-curation-runtime](../../../../openspec/changes/add-visual-curator-v1/specs/visual-curation-runtime/spec.md)。

| 要求与场景 | 当前测试映射 | 未证明的部分 |
| --- | --- | --- |
| R1 · R1a–R1d 随包提供与卸载 | [plugin-agent-loop.test.ts](plugin-agent-loop.test.ts)、[runtime-admission.test.ts](runtime-admission.test.ts) 和 [service-edge.test.ts](service-edge.test.ts) 检查卸载与排空；[随包 Web 场景](../../../../apps/web/tests/visual-curator-builtin.e2e.ts) 检查无需 profile 副本的启用、无接口配置创建风格、停用刷新、再启用数据保留及 AFP 可用；profile 与 Desktop 定向测试检查新默认、旧选择保留和缺包拒绝。 | 实际签名桌面安装包和真实来源／模型部署尚未验收；独立 tgz 和随包链路不替代这些检查。 |
| R2 · R2a–R2c 归属与 writer | [runtime-lifecycle.test.ts](runtime-lifecycle.test.ts) `denies cross-profile, cross-Session and Agent access`；[service-edge.test.ts](service-edge.test.ts) `Agent-created Run and provider assets retain Session ownership`、`human reads cannot authorize Session resources`、离线 Agent export 另一 Session 拒绝；[domain.test.ts](domain.test.ts) `rejects a second profile writer and allows takeover after release`、不可变归属拒绝。 | 缺口：显式 library-save 创建新关联后，另一 Session 可读 library 像素但仍不可读原 run 的完整正反案例。 |
| R3 · R3a–R3d 生命周期 | [runtime-lifecycle.test.ts](runtime-lifecycle.test.ts) `retains the exact spec/checkpoint and creates a new attempt after pause`、`marks interrupted external reservations unknown`、`blocks late success and preserves spent quota`；[runtime-admission.test.ts](runtime-admission.test.ts) `shutdown waits`；[search-workflow.test.ts](search-workflow.test.ts) committed 响应重放案例。 | 缺口：暂停后改配置 revision 的显式 resume 拒绝；真实进程终止／重启的支持 profile 记录；生产 Session 停止事件的取消排空测试。 |
| R4 · R4a–R4c 预算与结构化错误 | [runtime.test.ts](runtime.test.ts) 最后配额与重试；[runtime-lifecycle.test.ts](runtime-lifecycle.test.ts) preflight／并发预算／deadline；[media-vision.test.ts](media-vision.test.ts) `preflights multi-image capability`；[search-workflow.test.ts](search-workflow.test.ts) 未知下载字节不退回；[plugin-tools.test.ts](plugin-tools.test.ts) `safe adapter failures retain structured cross-bundle codes`。 | 缺口：可重试 HTTP 超时／限流与其他 worker 同时运行时，实际网络尝试数、并发峰值及总账一致的组合测试。 |
| R5 · R5a–R5c 媒体安全与模型输入 |[media-network.test.ts](media-network.test.ts) 私网／DNS／重定向／本地例外／流量限制；[config.test.ts](config.test.ts) endpoint 与纯 origin 检查；[media-assets.test.ts](media-assets.test.ts) MIME／动画／路径与摘要拒绝；[media-vision.test.ts](media-vision.test.ts) `sends actual multi-image pixels`、`invented image evidence`；[plugin-agent-loop.test.ts](plugin-agent-loop.test.ts) 检查辅助请求事件和日志不含定位地址或 base64。 [真实 Session 场景](../../../../snapshots/session/visual-curator/snapshot.yml) 通过支持 profile 回放，保留辅助请求 plugin records。| 公网跨 origin redirect 的实际接收端凭据断言未独立执行；现有受控 HTTP 检查和发送范围测试保留。 |
| R6 · R6a–R6c 工作台与八工具 |[client-store.test.ts](client-store.test.ts) 背景刷新保留筛选／选择／预览、分页、失败保留数据、Session grant 和私有资源地址；[plugin-tools.test.ts](plugin-tools.test.ts) `exactly eight operations`；[plugin-agent-loop.test.ts](plugin-agent-loop.test.ts) 真实 loop 读／启动／建议／拒绝／卸载；[浏览器记录](#浏览器与文档检查记录) 确认部分工作区闭环及 390px 页面无横向溢出。 浏览器四工作区、改判、暂停恢复、取消、数据/Skill 下载和390px布局完成；Escape 关闭后焦点返回触发按钮。| 未逐一键盘操作每个表单，也未执行真实接口设置保存；不把基础焦点检查当作完整可访问性审计。 |

## 评估与导出

规范：[visual-curation-export](../../../../openspec/changes/add-visual-curator-v1/specs/visual-curation-export/spec.md)。

| 要求与场景 | 当前测试映射 | 未证明的部分 |
| --- | --- | --- |
| E1 · E1a–E1c family 与独立数据 | [domain.test.ts](domain.test.ts) `rejects duplicate family assignments and learning with holdout`、`refuses turning a calibrated learning family into independent holdout`、`keeps holdout protection after omission and retires historical holdout after disclosure`、`merges visually related families without changing source records and rejects old split collisions`、`confirms family membership with an independent immutable audit record`。 | 缺口：独立人工近似分组质量；界面合并及重新划分需浏览器记录。对来源分组的人工确认不能宣称自动近似识别通过。 |
| E2 · E2a–E2c candidate 与诚实指标 |[domain-data-workflows.test.ts](domain-data-workflows.test.ts) 未发布 candidate 对比及 budget-exhausted 的 pass／technical-failed／unprocessed 全量指标；[domain.test.ts](domain.test.ts) `reports unavailable rates for absent labels`、`keeps failed human positives in recall and reports precision`；比较不切默认有直接断言。 [domain.test.ts](domain.test.ts) `retains improving recall and worsening crop damage` 保留改善与退步及各自分母；浏览器比较1个去重输入、4次调用、零标签 unavailable。| 未单独执行不匹配报告的发布拒绝；图片比较不生成新的裁图，独立裁剪质量缺失时保持 unavailable。 |
| E3 · E3a–E3c 有效头与导出快照 |[domain.test.ts](domain.test.ts) `freezes feedback heads and checksums`、比较 unknown／建议排除、opted-in crop 且 development 不进入 training；[service-edge.test.ts](service-edge.test.ts) `an export uses its accepted feedback heads`；[domain-data-workflows.test.ts](domain-data-workflows.test.ts) 离线固定头导出。 [acceptance-edge.test.ts](acceptance-edge.test.ts) `an authorized byte export downloads verified resources and identical retries` 验证相同 operationId 返回原 Run、不新增任务。| 未把所有无资格来源放入同一导出的排除计数组合；现有各类排除测试保留。 |
| E4 · E4a–E4c 格式与图片字节 |[domain.test.ts](domain.test.ts) `exports left, right, tie and neither as distinct preferences` 解析 JSONL；`exports only explicitly opted-in generated crop confirmations with their actual geometry` 解析实际区域；`freezes feedback heads and checksums and refuses unauthorized byte exports`；[service-edge.test.ts](service-edge.test.ts) 离线 style 引用导出、未授权带图失败不产生完整包；[media-assets.test.ts](media-assets.test.ts) 缺损 blob 拒绝。 [acceptance-edge.test.ts](acceptance-edge.test.ts) `an authorized byte export downloads verified resources` 验证带图字节摘要、文本 checksum、下载逐字节相同；删除 fixture blob 后禁止新 export 提交。| 已有合法、未授权、缺损三类决定性结构验证；真实授权来源及许可由用户另验。 |
| E5 · E5a–E5b Skill 仅为产物 | [domain.test.ts](domain.test.ts) `freezes feedback heads and checksums` 对 Skill 文字断言 `resources are unavailable` 与 `does not activate itself`；[service-edge.test.ts](service-edge.test.ts) 离线导出不调用供应商。 | 缺口：实际预览／下载 Skill 前后，测试所有者临时 Home 指令目录、Session 事件和插件开关无写入的执行证据；文本断言不能替代该副作用检查。 |

## 联动脚本与外部验收

T1–T4 需要跨工作区、运行中变更与故障重启的同一执行链证据。当前测试分别覆盖大量组成行为，尚不能将它们合称四个脚本完整通过。本轮已补十张目标保留六张的真实 RunEngine 预算案例、浏览器坐标调整取消及在途取消；实际指针拖动取消、真实 Host 强制退出后的恢复链和 Home 副作用观察仍未逐脚本完整执行。

真实图片来源、视觉接口和风格试用已由用户明确延期，不属于本轮本地结构验收的失败项；本表不将其记为 PASS。供应商固定版本声明、价格／账单以及人工质量目标未由本表提供。缺这些输入时仅能报告结构性 fixture 验证。执行记录应注明命令、源码版本、fixture／provider、runId 和固定 release／usage／split，并由主验收记录登记 PASS、FAIL 或因部署输入缺失而 BLOCKED。

## 浏览器与文档检查记录

主流程在受支持的 `dsh web --patch` profile 上使用 [真实插件与 service fixture](fixtures/browser-plugin.ts) 检查浏览器。下表记录主流程已明确回报的观察；精确 runId、截图与操作轨迹由主验收记录保存。fixture 仍使用受控来源／模型，不能当作真实供应商验证。

| 已确认操作 | 观察与限制 |
| --- | --- |
| fresh 导入 → 分析 → 规则确认 → candidate → publish → default | 实际工作台闭环完成，发布与设默认是两个操作；不代表混合文件批次、冲突解决或质量目标已验收。 |
| 9:16、90×160、目标一张搜索 | 实际 sharp 成图及视觉复核完成，console 错误数为零；不是 T1 的 10 张取 6 张脚本。 |
| 390px 窄屏 | document 宽度为 390；末尾 tab 位于可滚动容器内，页面没有横向溢出。键盘和焦点恢复仍需独立记录。 |
| 人工裁图与反馈 | crop-confirmation 与学习选择独立确认；style-verdict 证据修复后 accept→reject 改判通过，历史与分歧队列可读。暂停→恢复完成目标；另一个在途任务取消后保持0个结果。 |

文档变更后执行 `pnpm run test:docs`，21 项检查全部通过。`pnpm run verify-translation-pairing --write custom-plugins/workspace/dsh-plugin-visual-curator/README.md` 已重录双语摘要；`node scripts/check.mjs` 三个 compiler face 通过。针对配置、固定审核和 family／导出的 `node --import tsx/esm --test tests/config.test.ts tests/frozen-review.test.ts tests/domain.test.ts` 为 28 项通过。默认 `doc-sync` 的两个失败、单独重试及文档站本地替代命令通过的结果见主验证记录。

最终证据以 [OpenSpec 验证记录](../../../../openspec/changes/add-visual-curator-v1/verification.md) 为准：本包107项、三面编译、真实Session回放与corpus、最新根构建、最终308键安装包均通过。此矩阵保留未独立执行的组合场景，10.1未勾选；真实接口由用户明确延期。
