## Why

文章生图工作台保存纯文本段落，尚未接入工具包的浏览器渲染，也没有获取正文原图或自动启动分析。用户每天从 Google 表格整理已公开的文章，需要在工作台完成富文本与原图核对、自动理解、配图提示词编辑和人工审核。

## What Changes

- 插件 Host 统一拥有业务记录和任务，复用 `article-image-toolkit` 的提取内核，结束工作台与工具包提取能力分别维护的状态。
- 通过浏览器获取有序正文块和公开可得的原图，保存图注、位置及本地资产，剔除导航、广告、推荐和站点控件；用质量报告暴露缺失与限制。
- 提取通过质量检查后自动启动专用分析会话，完成全文和原图理解、配图规划、提示词编写及结果检查，保存可定位的来源证据。
- 明确读取包内理解规范和 profile 自有规则文件，冻结每次任务实际采用的规则、正文、图片、业务备注及模型配置。
- 工作台展示真实任务阶段、正文与原图、理解稿和配图卡片，支持停止、显式恢复、编辑及人工审核。
- **BREAKING**：升级插件自有记录及文章/方案工具输出，更新全部消费者；保留旧记录与历史审核，旧纯文本需要重新提取后才能进入新流程。
- 第一阶段始终报告真实生图不可用；审核只确认方案，不提交生图、不上传、不发布、不回写表格。

## Capabilities

### New Capabilities

- `article-image-source-capture`: 统一提取内核、富文本与原图快照、提取质量、资产读取和旧记录迁移。
- `article-image-editorial-analysis`: 文件规则快照、全文及原图理解、证据引用、配图规划和结构化提示词。
- `article-image-analysis-workflow`: Host 自动编排、专用分析会话、任务检查点、取消恢复和真实进度。
- `article-image-human-review`: 富文本核对、理解与配图编辑、人工审核、审核失效和第一阶段执行限制。

### Modified Capabilities

无。当前 `openspec/specs/` 尚无文章生图能力规范；本变更新增上述四项要求，不修改 AFP 的能力规范。

## Impact

主要实现范围是 `custom-plugins/workspace/dsh-plugin-article-image/`，包括嵌套工具包、Host、Client、Skill、规则资源、配置、测试和 README。依赖接入涉及根 workspace 清单、锁文件以及必要的应用生产依赖/打包清单；新增模型或用户可见行为需补所属记录回放场景。复用 DSH Agent、模型、附件、任务和会话日志能力，不修改 agent-loop、AFP、全局 AGENTS、全局 Skills 或 Home 内容。

本变更按用户确认实施第一期，保留既有未提交改动，只修改所属插件、必要生产依赖、文档和验收场景，不更新用户运行中的 profile。完成状态与证据见 [实施记录](verification.md)；真实站点/模型语义由用户执行[人工验收](manual-acceptance.md)，未验收项保持未勾选。

文档入口：[技术设计](design.md)、[任务拆分](tasks.md)、[验收标准](acceptance.md)、[理解与提示词规范草案](editorial-guidelines.md)。
