# 原生模型容量与上下文压缩验收

日期：2026-10-28（Asia/Singapore）。状态：DONE。未提交、推送或归档。

## 结果

新原生任务通过原生 prepareCall 继承模型页的上下文容量、输出和推理默认值，插件不再覆盖为 8,192 token。历史冻结任务没有新标记时仍使用原参数，备用 HTTP 保持输出控制。归纳前仅在原生策略判定有压力时压缩观察文本；固定图片身份、人工判断与输出 Schema 保留。辅助调用受同一任务预算、截止时间和字节限制，保存实际输入、结束状态及返回用量，已提交响应可以重放。

Web 的聊天压缩属于 preset 私有作用域。工作台在无可见后端时挂载相同原生 Basic 实现的私有实例，关闭自动 Session 监听；显式 compaction 配置使用原生策略字段。卸载工作台会撤销该服务，不创建或修改 Session。

## 验证

| 检查 | 结果 |
| --- | --- |
| 插件全量 Node tests，concurrency=4、dot reporter | PASS，退出 0 |
| 插件 Host、Client、Tests 三个编译面 | PASS |
| 原生 Compaction 两包测试 | 8 个文件、186 项 PASS |
| 定向覆盖率：新增 input.ts 与 Compaction 服务定义 index.ts | statements、branches、functions、lines 均 100% |
| 实际 Loader YAML 组合、私有作用域、复用与卸载 | PASS |
| 观察压缩成功、截断、预算耗尽、已提交响应重放 | PASS；一个视觉并发名额下不会嵌套等待 |
| build:artifacts，及其后的 build:check | 12 + 2 gates PASS |
| test:docs | 21 gates PASS；最新文档再经定向配对、预算和升级说明检查 |
| Cordis API 生成与检查 | 125 个生成文件/区域一致；288 份配置检查 PASS |
| 导出 JSDoc、客户端 i18n、无新增 unknown 断言、定向 oxlint | PASS |
| OpenSpec 严格验证、UTF-8/BOM/换行与范围 | PASS |

首个模型继承回归先因旧 high 覆盖失败，移除原生覆盖后通过。新增独立压缩用例先因接口不存在失败，再逐步通过无压力、分组、截断、不完整、无收缩、超大固定输入/单块/响应、缺少容量、备用摘要路由、空文本、工具输出及取消等路径。未降低覆盖率或静态规则。

## 实际服务与页面

沿原启动参数重载本机 3080 服务前确认无活动分析或引用。重载后，同一所选路由 workbuddy/deepseek-v4.1-flash 返回 contextWindow=1,000,000、maxOutputTokens=128,000，配置 useModelDefaults=true。实际页面显示 1,000,000 和 128,000，均为只读。受控 1M/64K 目录的保存验证也通过，不提交插件输出上限；目录加载、模型删除、深浅主题及 390px 检查通过，无页面异常。

重载前后 14 条分析 runId 一致，活动数为 0；没有恢复取消任务或新增付费模型调用。页面受控保存由浏览器响应截获，没有改写用户实际模型选择。实际运行检查只核验配置和界面，不代表已完成供应商的真实推理质量验收。

## 修改文件与影响

| 文件（相对仓库根） | 目的与影响 |
| --- | --- |
| packages/compaction/compaction/src/index.ts、src/types.ts | 独立输入压缩协议与不支持后端的明确拒绝 |
| packages/compaction/compaction-basic/src/index.ts、src/input.ts | 原生策略、计量、有界分组与完整响应验证 |
| packages/compaction/compaction-basic/tests/input-compaction.spec.ts、tests/loader-composition.spec.ts；packages/compaction/compaction/tests/compaction.spec.ts | 压缩、取消、错误、原生组合及服务定义回归 |
| custom-plugins/workspace/dsh-plugin-visual-curator/src/host/config.ts、native-vision.ts | 新任务继承标记及实际模型容量记录，旧任务兼容 |
| 同插件 src/host/context-compaction.ts、data-workflows.ts、service.ts、plugin.ts | 原生压缩、任务预算与回执重放、Web 私有作用域及配置保存 |
| 同插件 src/host/vision-models.ts、src/shared/vision-models.ts、src/client/vision-models.ts、contract.ts | 原生目录容量/输出投影与参数继承 |
| 同插件 src/client/workbench.tsx、workbench-locale.ts、analysis-dialog.tsx | 只读容量、输出默认值及本地化压缩失败提示 |
| 同插件 tests/native-vision.test.ts、managed-models.test.ts、analysis-runtime.test.ts、helpers/service-fixture.ts | 模型继承、历史请求及明确 HTTP 夹具 |
| 同插件 tests/context-compaction.test.ts、context-composition.test.ts、fixtures/native-context.expected.json、fixtures/managed-models-browser.mjs | 工作流快照、真实 Loader 与页面回归 |
| 同插件 package.json；pnpm-lock.yaml | 原生 Compaction/token-meter 工作区依赖与测试依赖，无新增第三方运行库 |
| scripts/gen-cordis-catalog.ts；packages/extensions/tool-cordis/src/api-catalog.ts | 压缩类型链接与生成 API；同一索引补齐工作区既有原生搜索类型的文档链接 |
| docs/subsystems/compaction.md、compaction.zh.md、compaction.i18n.yaml | 独立输入协议与生成方法 |
| docs/subsystems/llm-streaming.md、llm-streaming.zh.md | 共享生成器补齐既有原生搜索类型链接，不修改其功能 |
| 两个 Compaction 包及插件 README.md、README.zh.md、README.i18n.yaml | 当前使用方式、参数及失败约定 |
| docs/upgrade-guide/v0.2.1-rc.3/visual-curator-native-context/guide.md、guide.zh.md、guide.i18n.yaml | 新默认行为与迁移说明 |
| 当前 OpenSpec proposal、design、specs、tasks、verification | 独立变更、验收与后续定位 |

AGENTS.md 在工作期间由用户外部更新，本轮没有编辑；其余初始工作区变更保留。范围检查以初始状态、上述文件和外部用户更新为基线，不把其他工作归入本轮。

## 限制与回退

原生计量继续使用项目文本估算，不能承诺供应商精确分词或摘要无信息损失。原始观察、人工判断和引用仍然保留；固定输入或单个块不能安全压缩时明确失败。模型和压缩策略需声明有效容量；历史失败任务不原地改参数。

源文件备份：C:/Users/zhuyi/AppData/Local/Temp/visual-curator-native-context-kkjYEe/。scope.json 与 baseline-status.txt 记录范围和已有修改。仅按本清单恢复对应文件，移除本轮新文件并重新生成、构建；不要整仓回退，不删除增量存储或已有任务数据。生成目录与配对记录应从恢复后的源码重新生成。
