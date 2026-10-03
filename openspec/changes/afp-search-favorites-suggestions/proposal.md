## Why

图库搜索缺少将选中图片加入收藏夹的入口，也缺少来自现有 Skill 搜索配置的关键词提示。用户需要在 AFP 插件内完成选图、检索词选择和确认加入收藏夹。

## What Changes

- 搜索结果操作栏增加批量加入已有私有收藏夹的图标按钮和确认弹窗，支持跨收藏夹选择。
- 添加前检查目标成员，区分新增、已存在、失败和待确认结果，保留原有收藏关系。
- 增加由现有搜索配置生成的关键词目录、中文别名和分类联想菜单，选择只填入输入框。
- 保持 120 张批次上限、写入开关、普通 caption 搜索语义和全部现有配置界面。

## Capabilities

### New Capabilities

- `afp-search-favorites`: 搜索页批量确认加入已有收藏夹。
- `afp-keyword-suggestions`: 插件内 Skill 关键词目录和可键盘操作的输入联想。

### Modified Capabilities

无。

## Impact

仅修改 custom-plugins/workspace/dsh-plugin-afp 及本记录。关键词目录在插件构建时从 Host 使用的 CATEGORY_PROFILES 生成，避免新增运行时查询接口和逐键网络请求。收藏夹私有结果增加新增/已存在标记，客户端兼容旧 Host 返回值。无需修改 DSH 公共组件或公共 API，也不新增依赖；不包含新建收藏夹、完整搜索策略或官方 WebSocket 建议。
