# 首屏搜索入口修复

## 证据与原因

2026-10-04 用户报告中，搜索 cat、猫、nebula 共 14 次使用 cursor="?"，均失败；另有 cursor="0" 和空白输入验证错误。真实 Session 的 tool/call 与报告一致，当前 request/header 中 afp_photo_search.required 仅含 query，cursor 为可选字符串。已移除前瞻正则的新版 schema 出现在该 Session 后续请求头中，实际工具调用已执行，因此上一轮模型请求 400 的修复生效。目录、收藏夹成员分页和图片详情也有用户提供的成功证据。

模型仍填入占位游标，且在 retryable:false 后重复不变调用。不能从 Session 声明推断自定义模型网关实际收到或转换的 schema，网关是否强制字段仍未确认。当前 pi-ai 本地 Responses 工具转换默认 strict=false，只有显式 strict=true 时才将可选属性补为可空必填属性；这些源代码事实不证明用户上游网关行为。认证 Host 差分验证中，cat/en/limit=1 带 "?" 被拒绝，省略 cursor 返回 1 张。该缺陷是首屏工具入口容易被误用，不能用本报告断言 AFP 认证失败或没有搜索能力。

## 行为与范围

新增 afp_photo_search_start，query、language、limit 必填，不提供 cursor 属性；传入 cursor 会在本地校验阶段拒绝。该工具复用既有 photo-search Host 操作与允许的元数据投影。首屏返回 hasMore=true 时，用原 afp_photo_search 及返回游标继续，保持查询和语言一致。原工具仍支持首屏省略游标，已知无效占位值 "0"、"?" 在本地返回 invalid-cursor，不隐式转为首屏；重复提交这些值也不会调用 AFP。错误建议与两个搜索 Skill 引导到新入口，不缓存失败结果，也不阻止后续改正参数后的有效调用。

修改仅包含 AFP 插件的 src/host/afp-agent-tools.js、src/host/afp-agent-errors.js、tests/agent-read-tools.test.js、tests/session.test.js、tests/fixtures/session-search.expected.json、两个搜索 Skill、README 中英文及配对记录，以及本 OpenSpec 的规格、任务和此证据。原有页面配置草稿、其它插件、模型适配器、公共接口和 recipes.json 保留。没有修改核心或模型网关，也没有执行购买、写入、下载、视觉刷新或打开浏览器。

## 验证

新增两个回归首先失败：首屏入口不存在；"?" 透传 AFP。修复后读取测试 13 项通过，包含必填与多余字段、语言及数量限制、旧调用兼容、重复占位值无远端读取、取消、权限撤销、注册释放和脱敏输出。真实 keyless DSH Session 快照记录首屏 schema、首屏与翻页调用和占位游标错误，快照更新后正常回放通过。完整 npm test 为 178 项通过，0 失败、0 跳过；npm run check、中英文配对、严格 OpenSpec、UTF-8/BOM/换行及 diff 检查通过。没有因 Host 工具改动重新生成不受影响的客户端产物。

AFP 筛选、下载均无活动任务时，按已有授权通过 pnpm dsh web --no-open 重载，3080 监听 PID=1112。已核验安装链接源文件一致。两个受管理 Skill 仅在所有权标记、非链接和修改前内容完全匹配时同步，并保留部署前备份。认证 Host 加本地注册包装器读取如下；不是实时模型生成测试。

| 查询 | 返回数量 | 分页唯一数 | 耗时 ms |
| --- | --- | --- | --- |
| cat/en/limit=10 | 首屏 10，下一页 10 | 20 | 2459，1913 |
| 猫/en/limit=10 | 0，hasMore=false | 0 | 1433 |
| nebula/en/limit=10 | 10，hasMore=true | 10 | 1639 |

全部 12 项 AFP 工具注册可检查。首屏 schema 经本地 pi-ai convertResponsesTools 的 strict=false、true 转换都保持 query/language/limit 必填且没有 cursor。三次已知无效游标调用返回 invalid-cursor，远端 photo-search 次数为 0。实时模型接口本轮未调用，实际 Agent 对新入口的使用和不重复非重试错误仍需新 Session 验收；不能把本地脚本成功当作模型遵循 Skill 的证据。该账户没有可用于实际共享读取测试的命名只读收藏夹，模拟共享读取回归通过，实际共享权限仍未验证。

## 回滚与复测

本轮修改前文件备份位于 C:/Users/haige/AppData/Local/Temp/afp-first-page-fix-20261004，按插件相对路径保存；两个部署 Skill 另有 deployed-before.md 备份。只恢复本轮目标文件并重载 Host即可回退；不要覆盖其它未提交修改。私有启动日志含登录 URL，不得提交或分享。运行证据文件 differential.json、runtime-evidence.json 不含凭据或游标值。

新建 Agent Session，确认可调用 afp_photo_search_start，加载最新版搜索 Skill后执行：只读测试；分别调用 afp_photo_search_start({"query":"cat","language":"en","limit":10})、afp_photo_search_start({"query":"猫","language":"en","limit":10})、afp_photo_search_start({"query":"nebula","language":"en","limit":10})。cat 首屏成功且 hasMore=true 时，用返回 cursor 调用 afp_photo_search 读取第二页；查询和语言保持不变，不编造或打印完整游标。每个参数组合只调用一次，retryable=false 时停止该用例。报告实际工具、参数、数量、耗时、分页新增/重复/累计唯一 ID、hasMore、错误 code/stage/action/retryable；第一屏前 3 项 ID/标题/provider可作为结果证据。没有工具或前置失败则标记 BLOCKED/FAIL，不使用离线计划冒充搜索结果。不得启动 refresh、购买、下载、写入或浏览器。若仍误用旧首屏入口或重复调用，将其列为 Agent 执行失败并附实际参数，不再发起相同请求。
