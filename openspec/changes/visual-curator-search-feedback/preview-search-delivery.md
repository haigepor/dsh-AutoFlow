# 预览找图与紧凑任务反馈交付

本次实现和定向验证已完成；全仓类型汇总检查存在范围外阻塞，不能声明全仓检查通过。修改未提交、未推送，运行中的应用服务没有重启，也没有新建付费找图任务。

## 后台任务

修改前通过运行中服务的正式 `search-launch-stop` 操作停止启动 `949d1789-e443-4ba7-b3d0-9f34f7a3392e`，HTTP 200。关联 Run 为 `da92b9ba1bc95194c7b46927d5d84205cba3465ef234ff64f61f8ea54de71ddd`。收尾时再次通过服务查询，启动的 `status/stage` 均为 `stopped`，`runStatus` 为 `cancelled`。保留历史结果，不删除任务数据。

## 诊断结论

- 所选数据集和 Run 的画像 ID、内容摘要相符，问题不是漏传数据集。该数据集有 11 条启用规则，全部为偏好规则，没有主体维度规则或必选规则；这些资料没有被本次修改重写。
- 原任务有 18 个中文检索提示，但长时间只处理首个宽泛的“汽车摄影”查询。某候选连续三次原图下载超时，每次约 180 秒，累计约 9 分钟；人物拍摄、地下车库、车顶设备等候选混入召回。
- 原判断将未知证据直接留待复核，即使其余已违反规则已足以判定无法达标。现按未知权重的最高可能满足比例判定，保留原阈值和真正未决状态。
- 会话停止与独立 Run 取消属于不同生命周期，原后台当时确实继续运行；卡片还可能显示较旧的详情。现提供明确的后台停止入口，并按修订号处理状态更新。

## 实现

默认新启动使用 `output.kind: preview`，目前支持 Unsplash。Agent 从所选数据集启用规则及备选组提出预算内的英文主体与风格检索词，worker 在各查询之间轮流处理候选。常规公开预览 URL 进入实际视觉复核，来源阶段与终审阶段规则一起审核；不下载原图、不裁剪、不创建交付目录。视觉服务处理 URL 时仍可能读取预览像素。

投影和工具明确区分“预览匹配”、来源链接去重与原图核验。原图和用途输出仍可显式选择，已受理任务保留原输入。原有参考图最多 4 张、按 ID 排序采样的策略保持不变，本次没有增加向量相似度或训练模型。

任务顶栏仅保留身份、状态、一次目标进度和操作，下方保留分类筛选。完整需求、次要统计、结束原因、交付及候选诊断放入原生“任务详情”菜单。重复结构化候选 ID 和错误码的旧警告归并，其他警告保留；终态隐藏过期阶段，预览卡片提供打开链接操作。布局复用项目现有 token、Menu、Button、Tag、Modal 和响应式规则。

## 验证

| 检查 | 结果 |
| --- | --- |
| 插件目录 `node scripts/test-preview-search.mjs` | 60 项通过，0 失败、0 跳过；使用实际生产代码及受控外部响应 |
| 插件 `node scripts/build.mjs`、`node scripts/check.mjs` | 构建通过；Host、Client、tests 三组类型检查通过 |
| 原生浏览器 fixture 的 `preview-search-browser.mjs` | 保存的预期输出一致；1920px 主信息行 28px，390px 为 64px；含筛选的顶部总高分别 98px、170px；无横向溢出，菜单保持在视口内，Escape 关闭，预览没有裁剪和原图交付提示，0 pageerror、0 console error |
| `pnpm run build:artifacts` | 12 个构建检查通过，0 失败、0 跳过 |
| 随后 `pnpm run build:check` | Host 汇总通过；Client 汇总失败：范围外 `packages/client/ui-chat/tests/user-content.client.spec.tsx:91` 注册缺少必需的 `inject`，TS2345；该测试未被本次修改 |
| README 翻译配对、`pnpm run verify-md-wrap`、OpenSpec strict 校验 | 均通过；Markdown 检查覆盖 2101 个文件 |
| UTF-8、BOM、换行及本次增量检查 | 无替换字符、BOM 变化或混合换行；以交付时的校验记录为准 |

流程脚本执行实际 RunEngine、UnsplashSourceProvider、CompatibleVisionProvider、DomainRepository、启动受理和会话观察代码；只替换来源与模型网络响应。测试覆盖跨查询轮询、不匹配淘汰、取消、零原图下载、原图模式回归、授权和陈旧状态。它不能证明真实图库召回质量、视觉模型审美效果或供应商计费。

工具声明序列化文本由 10332 增至 10630 字符，UTF-8 由 10336 增至 10634 字节；未安装相应 tokenizer，未测首轮供应商完整提示的 token 数，也没有为测量发起模型请求。

## 修改文件与影响

下列路径以 `custom-plugins/workspace/dsh-plugin-visual-curator/` 为起点；交付目录的 `changes.json` 逐文件记录前后哈希，`deltas/` 保存本次增量。

| 文件 | 用途与影响 |
| --- | --- |
| `src/shared/search-launch.ts`、`src/client/contract.ts` | 显式预览输出、Run 修订号与安全预览链接；保留旧输入读取 |
| `src/host/preview-search-workflow.ts`、`src/host/search-workflow.ts` | 新增可恢复的预览 worker，分派新输出；原图流程保留 |
| `src/host/review.ts`、`src/host/style-execution.ts` | URL 复核、跨阶段规则及无法达标的未知证据处理 |
| `src/host/service.ts`、`src/host/search-launch.ts`、`src/host/projection.ts`、`src/host/tools.ts` | 能力声明、固定参数与查询计划、无原图交付、投影和 Agent 工具语义 |
| `src/media/unsplash.ts` | 使用 regular 预览替代小缩略图 |
| `src/client/search-launch-store.ts`、`src/client/search-launch-dialog.tsx`、`src/client/search-feedback-locale.ts` | 默认预览、Host 能力检查、本地化及已有类型错误修复 |
| `src/client/conversation-feedback.ts`、`src/client/conversation-task-dock.tsx`、`src/client/index.ts` | 授权停止、修订号状态与后台控制反馈 |
| `src/client/task-history.tsx`、`src/client/entry.css` | 紧凑顶栏、原生详情菜单、预览操作及窄屏布局 |
| `tests/preview-search-flow.test.ts`、`tests/conversation-feedback.test.ts`、`tests/search-launch-client.test.ts`、`tests/search-launch.test.ts`、`tests/unsplash.test.ts`、`scripts/test-preview-search.mjs` | 流程、取消、授权、兼容性与零原图下载回归；修正旧测试缺失数据集准备 |
| `tests/fixtures/search-feedback-ui.mjs`、`tests/fixtures/build-search-feedback.mjs`、`tests/fixtures/preview-search-browser.mjs`、`tests/fixtures/preview-search-ui.expected.json` | 原生组件预览场景及可重跑的浏览器预期输出 |
| `README.md`、`README.zh.md`、`README.i18n.yaml` | 同步使用语义、限制和测试入口 |
| `index.js`、`tools.js`、`client.js` | 从本次源码重新生成的插件入口产物 |

本 OpenSpec 目录同时更新 `design.md`、`tasks.md`、`specs/visual-curator-search-feedback/spec.md` 和此交付记录。仓库整体构建还按现有构建流程重新生成其他当前源码对应的产物；没有手改其他功能源码。

## 回滚与使用

修改前的文件保存在 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-preview-search-20261029/before/`，其中包含本轮开始前已有的未提交修改。相邻 `scope.json`、`changes.json`、`task-only.patch` 和 `deltas/` 记录本次范围。回滚先检查 `git apply --reverse --check` 对该补丁是否通过，再逆向应用；后续有人修改相同文件时不要直接整文件覆盖或 reset。回滚代码不会恢复已停止任务，也不会回滚用户数据。

临时浏览器 fixture 页和 3091 测试服务已关闭，用户的 3080 应用页保留。新 Host 模块需要重载应用服务并刷新页面后生效；本次没有自动重启服务或恢复旧找图任务。下一步仅为重载后的少量真实预览样本验收；范围外的 ui-chat 汇总类型错误需由其当前改动继续处理。
