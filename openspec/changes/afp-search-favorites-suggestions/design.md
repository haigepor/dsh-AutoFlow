## Context

搜索页使用共享 selectedPhotos 和 photoSources；Host 已提供确认后调用的 copy 操作、目标成员去重和验证。搜索输入仍是普通 caption 文本。现有项目导出 Input、Modal、MenuSurface 和菜单尺寸/关闭辅助能力。

## Goals / Non-Goals

实现批量加入已有私有收藏夹、精确结果反馈、Skill 关键词及中文别名联想。保留原有收藏关系和跨页选择，操作受 write 开关与 120 张上限保护。不增加实时 WebSocket、AI 扩词、新建收藏夹、搜索策略执行或核心组件修改。

## Decisions

- 构建时从 CATEGORY_PROFILES 的正向词和结构化来源生成客户端目录，与客户端一起发布。按词归一化去重并保留多类别归属，不解析 Markdown 或 NOT 子句；目录不会包含认证或图片信息。这样可离线提示且无需新增 Host 读取 API。
- 联想在插件本地组合项目 MenuSurface 和输入框；保留焦点，用 combobox/listbox 语义、活动选项和键盘导航。菜单 Portal 到 body，测量输入框并避让窗口边缘；中文输入法组合期间不接受/提交 Enter。点击只填入普通关键词。
- 加入收藏夹弹窗固定打开时的图片与来源快照；目标来自最新收藏夹目录，私有且可写，支持搜索。已有部分图片的目标仍可选择。提交复用 copy；Host 为 copy 成功项增加 membershipChange 区分 added/already-present，客户端在旧 Host 上显示不带虚构细分的完成数量。
- Host copy 只读取目标成员，保留已知来源 ID；不会因已消失或只读的来源阻止加入。move/remove 的完整来源验证不变。加入结果保持原选中图片，并将已验证目标并入来源记录；失败或结果不明不自动重试。
- 确认后的请求归共享客户端 store 管理，弹窗提交期间不可关闭；后续目录刷新错误不覆盖已经成功的写入结果。普通 caption 查询、语言与分页行为不变。

## Risks / Trade-offs

文本建议不保证视觉主体匹配；界面以关键词推荐展示。Host 文件更新需要正常重载才能返回细分数量；客户端兼容原有结果。窗口布局由用户手动验收，不启动浏览器。变更前保存插件文件备份，回退仅恢复本轮对应文件。
