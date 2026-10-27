## Context

工作台已有画像、用途记录、RunEngine、selection 和 Session 通道；真实调用入口缺少用途发现与启动准备，公开投影不区分源图和入选成图。范围为 L，按 A→B→C 独立验证，保留当前 UI primitives 与样式。

## Goals / Non-Goals

目标是从画像创建用途并启动搜索/自动裁剪，通过原 Session 打开任务，准确识别入选结果，并使当前启用规则决定新任务的实际风格判断。排除人工反馈学习、拖拽裁剪、批量下载、供应商质量与计费验收、共享包和全局控制文件修改。

## Decisions

- A 复用 action 协议；usage-list 返回各 preset 最新 revision 并分页，usage-save 接受 expectedCurrentRevisionId。task-prepare 为只读操作，不创建任务或调用供应商，缺项/配置问题分别返回 needs-input/blocked；ready 返回规范化输入和不含秘密的摘要。准备和启动共享解析，摘要涵盖标准、当前画像头、用途、配置、输入与策略；启动拒绝变化，已受理 operationId 优先回放。
- 工作台保留全局导航，在素材集内增加参考与画像/找图与裁剪。两步 Modal 内联保存用途，不叠加弹窗。TaskHistory 延伸为执行视图，保护原材质、颜色、间距、图标和反馈组件。
- B 复用 session-open/openSession 和原资源授权；用户点击任务入口后打开原 Session，令牌仅保留内存。工具卡片通过原 tool.call.toolview 注册，可信 Session 上下文决定会话身份，不信任模型传入的所有者。范围切换取消旧读并清除私有视图。
- run-get 增加 owner、styleId、resultSummary、selection 身份、reviewStage 和可选 styleMatch。结果筛选绑定分页摘要，汇总先授权后计数；只有真实 selection 属于最终入选。任务详情显示 outcome 和 warnings。历史记录从已保存记录投影，不将 pass 推断为入选。
- C 当前 options/rules 编译为固定执行说明，旧 matchingPrompt 只作历史描述；调整后的画像不自动沿用旧搜索提示。新模型画像任务固定版本二执行策略及实际评估 recipe；旧任务和人工发布版本沿用原行为。
- 终图重查启用视觉偏好；required/measured 仍遵循原阶段。按现有维度权重在启用规则内归一化，同维度规则分摊权重；共享偏好与任一备选风格组分别满足门槛，未知保留 needs-review。默认门槛 0.75 为可配置产品初值，不是概率或供应商质量保证。规则不因数量不足自动放宽。
- 不新增持久任务实体；使用既有 Run spec/checkpoint、recipe 和 assessment 的可选版本字段。请求描述及实际模型调用须包含相同固定规则和策略，已提交响应继续按版本和摘要重放。

## Risks / Trade-offs

- 真实模型质量未验证 → 使用受控图片/JSON/浏览器夹具验证流程，门槛由真实样本后续校准。
- 配置或图片可能在准备后变化 → 启动再检查；摘要不代替鉴权、文件校验或供应商错误处理。
- 老版本 schema 严格校验新增记录 → 旧记录读取向后兼容，运行升级后产生的数据不承诺旧插件降级读取；记录升级说明。
- Session UI 挂载复杂 → 仅增加本插件工具视图/注入回调，不修改共享布局或循环。

## Migration Plan

不批量重写已提交记录。新字段可选，缺少版本标记的任务走旧判断；新策略固定入新任务，暂停/恢复仍读原 spec。修改限本插件、当前 change、功能升级说明，以及 pnpm-lock.yaml 中该插件两项工作区类型依赖。回滚代码之前保留新增数据和本轮 Temp 源文件备份，不覆盖用户原有其他改动。

## Open Questions

无实施阻断决策。门槛 0.75 按用户确认方案实施，真实样本校准不属于本次范围。
