# 只读测试反馈修复

## 原因及证据

用户测试报告的搜索均失败。只读提取对应 DSH 会话 tool/call 参数后，确认 cat、猫、nebula 及重复搜索都传了 cursor="0"。2026-10-04 对同一 Host、相同 cat/en/limit=1 做差异验证：传 "0" 失败，省略 cursor 返回 1 张，分别耗时 2287/1794 ms；仅游标参数改变。此前省略首屏游标的成功探针没有覆盖这个 Agent 占位值错误。

工具描述此前没有明确首屏必须省略 cursor，校验也允许 "0" 透传。修复在 schema、说明及执行校验中拒绝这个已知无效占位值，返回 invalid-cursor、validation、retryable=false 和首屏省略建议；不自动转为首屏或重复搜索。其它游标仍按既有 AFP opaque string 处理，不猜测其编码规则。

未知只读异常此前沿用了涉及写入及部分结果的通用建议，修复后 stage=read，并仅建议检查读取参数、凭据和 AFP 可用性。已知 GraphQL 查询拒绝映射为 query-rejected；原始错误正文、令牌和签名链接不回传。写入错误处理和禁止自动重试写入的规则保持原状。

目录中空名称、count=null 的条目以 SANDBOX# 开头；不能据其非私有属性判断普通共享收藏夹成员接口失败。Agent 命名目录排除此类空名称条目，并用 meta.excludedUnnamedCount 保留排除数量；Host 在读取成员之前拒绝空名称条目，返回可安全分类的固定错误。命名的共享收藏夹继续保留在目录及读取流程中。

用户报告的收藏夹目录及私有成员读取成功，是当时远端认证读取可用的证据；status 中凭据引用存在仍不等于认证成功。重复提交相同非重试错误属于测试 Agent 执行问题，两项 Skill 已补充停止不变参数重试的指令；没有通过真实模型验证其行为一定遵循该指令。

## 改动及验证

变更文件：src/host/afp-agent-tools.js、afp-agent-errors.js、afp-workbench-data.js；tests/agent-read-tools.test.js、session.test.js 及会话快照；两项搜索 Skill、README 中英文和配对记录。本次代码仍限于 AFP 插件，OpenSpec 在当前 change 中追加反馈记录；无核心、配置或页面改动。

新增三个回归用例先运行得到 3 FAIL，再实现修复后 10 项读取工具测试通过。完整插件测试 node --test tests/*.test.js：175 PASS、0 FAIL、0 SKIP；keyless Session 快照新增占位游标拒绝调用。npm run check、README 具名配对、git diff --check、UTF-8/BOM/原换行及范围检查、严格 OpenSpec 校验通过。npm 的已有 auto-install-peers 警告仍出现，退出码为 0。

## 真实读取复核

按此前授权确认 AFP 活动筛选和下载均为 0 后，通过 pnpm dsh web --no-open 重载，仍使用 127.0.0.1:3080，监听 PID=37912，未打开浏览器。两项托管搜索 Skill 在确认与本轮修改前副本一致后备份并同步。验证路径为本地新 Agent 注册包装器调用认证 Host 真实操作；真实 DSH 循环中的工具注册及错误结果另外由 keyless Session 快照验证，不冒充真实模型自主调用。

| 检查 | 结果 |
| --- | --- |
| 首屏 cursor="0" | invalid-cursor，0 ms；单元用例确认未建立 AFP 读取连接 |
| cat/en/limit=10 | 首页 10 张、2195 ms；次页 10 张、1573 ms；20 个唯一 ID，无重复，游标变化 |
| 猫/en/limit=10 | 0 张、1882 ms、hasMore=false；实际零结果，不是调用失败 |
| nebula/en/limit=10 | 10 张、1775 ms、hasMore=true |
| 图片详情 | found=true，1784 ms |
| 收藏夹目录 | 31 个命名条目，excludedUnnamedCount=1，2198 ms |
| 收藏夹成员 | 连续两页各 10 张，nextOffset=10/20，20 个唯一 ID；4037/2320 ms |
| 共享成员 | 模拟命名共享条目读取通过；真实账户命名共享条目为 0，无法做真实共享数据复核 |
| 副作用 | 探针结束时 AFP 活动任务为 0；未启动购买、下载、筛选或关系写入 |

## 回滚及复测

本轮修改前源文件、部署 Skill 与脱敏探针结果保存在 C:/Users/haige/AppData/Local/Temp/afp-read-repair-20261004；afp-workbench-data.js 单独保存在该备份根目录，其余源文件沿相对路径保存。启动日志含私有登录 URL，不应分享或提交。恢复这些备份并重载 Host 可回滚本轮修复，不使用仓库 reset。

后续使用新 DSH 会话，首屏调用 afp_photo_search({"query":"cat","language":"en","limit":10})，省略 cursor。仅下一页填入前一页实际返回的 cursor；不得使用 "0"、空字符串或编造值。共享读取测试只能选择存在名称的只读收藏夹，没有这种条目时标为未验证；已有任务及页面缓存、布局等不属于本轮验证结论。
