# 模型工具 schema 正则兼容修复

2026-10-04 用户报告模型请求 HTTP 400：Invalid JSON schema: regex lookaround is not supported，param=tools。错误发生在模型请求校验阶段，AFP 工具尚未执行。根因为前一轮在 cursor.pattern 中新增了负向前瞻 ^(?!0$)[\\s\\S]+$；JavaScript 能执行该正则，但该模型接口不接受。

修复移除 cursor.pattern，保留 type、minLength、maxLength、首屏省略说明和 Host 执行阶段的 cursor="0" 拒绝。不会把错误游标静默改为第一页，也不影响既有搜索、分页或权限处理。此前工具执行与真实 Host 读取成功的证据没有覆盖模型接口对 schema 的接受情况，不能作为模型请求成功证据。

修改文件为 src/host/afp-agent-tools.js、tests/agent-read-tools.test.js、tests/session.test.js 和 tests/fixtures/session-search.expected.json；只在 AFP 插件中改动代码及测试，本 OpenSpec 同步记录说明。新增回归首先因前瞻正则失败，修复后读取工具与 keyless Session 共 12 项通过。检查覆盖 read、refresh、write 全部 11 个 AFP 工具 schema；会话快照记录实际模型可见的 cursor schema，并断言不存在 pattern。npm run check、UTF-8/BOM/换行、范围、git diff --check 及严格 OpenSpec 校验通过。

真实模型接口没有被本地测试再次调用；这些证据确认工具定义及模型可见 schema 已移除报告中的不兼容正则，不声称模型接口已返回成功。新建 DSH 会话后可继续使用原只读测试提示词；首屏省略 cursor，cursor="0" 用例现在由 Host 执行校验返回 invalid-cursor。

AFP 无活动筛选和下载时按此前授权通过 pnpm dsh web --no-open 重载，3080 新监听 PID=40400，安装链接的工具文件与源文件哈希一致，未打开浏览器。本地注册包装器检查 11 个工具、7 个普通 pattern，未发现前瞻；cursor 不含 pattern，"0" 仍被拒绝。调用认证 Host 搜索 cat/en/limit=2 返回 2 张，3935 ms。此探针验证真实 Host 读取及新工具包装器，不替代真实模型 API 接受测试。

回滚备份位于 C:/Users/haige/AppData/Local/Temp/afp-schema-fix-20261004，包含本轮修改前的工具源码、读取测试、会话测试和快照；恢复这些文件会重新引入不兼容正则。无需恢复其它此前修改。运行探针和启动日志也在该私有目录，启动日志包含登录 URL，不应提交或分享。
