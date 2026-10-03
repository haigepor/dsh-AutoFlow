## Why

AFP 工作台缺少账户档案与积分信息，收藏夹图片预览失败时无法区分接口、权限或 CDN 配置原因。长列表与详情共用滚动区域，限制了图片浏览和筛选。

## What Changes

- 保留用户名回显与敏感输入独立显隐，新增只读账户档案和真实积分余额，缺失数据明确显示未取得。
- 收藏夹增加骨架屏、短过渡、侧栏折叠、独立图片列表与详情滚动，以及阈值触发的回到顶部按钮。
- 优化图片选中、加载和失败状态，详情图片打开项目 Modal 大图预览。
- 对照本地 AFP-Image 接口证据，修复混合选集、名称/数量投影和预览响应中可复现的问题；不购买、下载原图或修改远端收藏夹。
- 为只读响应、取消与切换竞态、敏感数据投影提供回归验证，发布到本地 web profile。

## Capabilities

### New Capabilities

- `afp-account-profile`: 账户表单、只读用户档案与积分余额。
- `afp-collection-browser`: 收藏夹导航、图片列表、固定详情、大图预览与可诊断的媒体读取。

### Modified Capabilities

无现有 OpenSpec 能力需要修改。

## Impact

修改仅涉及 custom-plugins/workspace/dsh-plugin-afp 的 Client、Host 只读接口、相关适配模块、测试与文档；新增 account-profile 操作，保持既有 Agent 工具、写入确认和 profile 凭据存储。复用项目 Input、Button、Tooltip、Checkbox、Tag 与 Modal，无新运行时依赖。AFP-Image 仅供读取分析。页面由用户手动验收，不启动浏览器；更新 Host 后使用 --no-open 重启本地服务。
