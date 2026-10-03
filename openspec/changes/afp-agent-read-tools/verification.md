# AFP Agent 只读工具验证

## 交付范围

本阶段补齐 Agent 实际照片搜索、详情、完整收藏夹列表和成员分页。代码修改限于 `custom-plugins/workspace/dsh-plugin-afp/`，设计及验证记录位于本 change；未修改 DSH 核心、公共 API、依赖或 Web 端口配置。此前未提交的配置弹窗修复和 `recipes.json` 保留。

| 文件 | 用途 |
| --- | --- |
| `src/host/afp-agent-tools.js` | 注册四个只读工具、参数校验、允许字段投影、测量耗时和取消检查 |
| `src/host/afp-agent-errors.js` | 固定错误码及处理建议，不回传原始异常或上游响应 |
| `tests/agent-read-tools.test.js` | 搜索、分页、权限、取消、读取撤销和敏感信息隔离回归 |
| `tests/session.test.js`、`tests/fixtures/session-search.expected.json` | 真实 DSH 循环的无密钥会话快照，使用模拟 AFP 响应 |
| `tests/client.test.js` | 为既有共享操作测试补充部署 pageSize，保留此前 UI 测试修改 |
| 两项搜索 Skill、`package.json`、README 及配对记录 | 说明离线规划与实际查询、结果字段、错误处理和能力限制 |

## 本地验证

| 检查 | 结果 |
| --- | --- |
| 新工具回归首次运行 | RED：新增工具尚未注册及旧通用错误导致预期失败，随后实现修复 |
| `node --test tests/*.test.js`（插件目录） | PASS：172 项，0 失败、0 跳过 |
| 最终 `node --test tests/agent-read-tools.test.js tests/session.test.js tests/client.test.js` | PASS：15 项，0 失败、0 跳过 |
| `npm run build:client` | PASS：重新生成客户端产物 |
| `npm run check` | PASS：文件、导出、功能声明、语法及 UTF-8 检查 |
| `pnpm run verify-translation-pairing -- custom-plugins/workspace/dsh-plugin-afp/README.md` | PASS：本次具名中英文配对一致 |
| `git diff --check`、严格 OpenSpec 校验 | PASS |

完整插件测试首次出现的两个失败分别来自旧测试服务缺少 config.pageSize、错误快照保留动态耗时；已补齐模拟配置并仅归一化协议 ID 和测量耗时，再运行通过。npm 给出已有项目配置 auto-install-peers 的警告，命令退出码为 0。未运行仓库全量测试、浏览器自动化或任何购买及收藏关系写入。

## 真实 Host 读取

北京时间 2026-10-04，通过认证的 127.0.0.1:3080 Host 私有工作台操作执行只读验证。新 Agent 工具在本地注册测试架中包装这些真实 Host 操作；完整 DSH 工具注册和模型可见输出由前述真实循环的 keyless Session 快照独立验证。该远端探针不等同于直接读取 Web Host 的完整工具注册表或调用真实模型。

| 操作 | 实测结果 |
| --- | --- |
| `afp_photo_search`，cat、en、limit=2 | 第 1 页 2 张、2233 ms；第 2 页 2 张、1851 ms；累计 4 个唯一 ID、无重复、游标改变 |
| `afp_photo_details` | found=true，ID 与第 1 页一致，1463 ms |
| `afp_collection_list` | 32 个账户可见收藏夹，2019 ms |
| `afp_collection_items` | 旅游收藏夹连续两页各 2 张，nextOffset=2/4，4 个唯一 ID；4417/2561 ms |
| 空白查询 | invalid-arguments，validation，retryable=false，提供纠正参数建议 |
| 数据隔离 | 返回结果未包含 previewPath、mockup、accessToken、媒体 href/url 或签名参数；稳定 GUID 可采用 AFP 文档 URI |

重载前 AFP 没有活动筛选或下载，现有下载记录为 completed；按此前授权停止旧 Web Host，并通过 `pnpm dsh web --no-open` 隐藏启动新 Host，未打开浏览器。新监听 PID 为 45276，端口仍为 3080；安装目录仍链接当前 AFP 源码，Agent 工具文件哈希一致，read 能力已激活，探针结束后 AFP 活动任务为 0。会话列表安全预检返回 gateway/internal，未据此声称其它 Agent 会话均为空闲。

两项部署搜索 Skill 的托管副本与上一版 HEAD 完全一致，确认归属标记和目录无链接后，备份并同步当前源文件；部署哈希均一致。旧会话中已经加载的工具或说明仍可能保留，后续测试应新建 DSH 会话。没有通过真实模型验证其自主选择工具的行为，也没有进行页面视觉测试。

## 回滚及后续

本次源文件原状、原部署 Skill 及脱敏的真实读取探针记录保存在 `C:/Users/haige/AppData/Local/Temp/afp-agent-read-tools-Irt8ND`。按备份恢复本阶段修改文件、单独移除本阶段新增文件并重载 Host即可回滚；不应使用整个仓库 reset 或覆盖此前配置修复。该目录内启动日志含私有登录 URL，不应提交或分享。

本阶段完成；中文自动翻译、Facet/高级查询、任意搜索图片视觉筛选及下载恢复为 NEXT，需后续独立设计和验证。
