# 本地 fixture 验证记录

## 当前提交状态

2026-10-23：按用户后续指示移除旧工作台，插件详情改用原生 Plugin Manager 布局并加入生成的 PNG 标志。当前提供六项原生目录技能、三组共八个 Agent 工具及三个默认关闭的页面入口；页面入口仅显示“页面待设计”，风格、样例、找图裁图和数据操作页面尚待按新设计重建。Host 业务、数据及授权操作保留，AFP 文件未修改。

以下 PASS、工作台截图、包摘要和 50/52 统计是 UI 重置前的历史证据，不代表本次提交的页面已通过验收。UI 重置后根 build:artifacts 与 build:check 曾通过；新增十二项功能后仅更新插件构建产物及双语配对记录，用户要求不新增测试或浏览器验证。最近一次原生详情浏览器测试因旧 `main img` 定位超时失败；提交整理已改用原生 `data-plugin-detail` 定位并以六/三/三分组断言替换缺失的旧页面快照，尚未重跑。真实接口继续延期，当前 tarball 尚未按十二项功能重新打包。

## 历史 fixture 记录

验证日期：2026-10-23（Asia/Singapore）。源码提交及开始时的工作区清单保存在 [verification-env.json](verification-env.json) 指定的原始 `baselineRecord`，另有当前工作区改动；Node 为 24.14.0，pnpm 为 11.28.5，运行平台为 Windows x64。本轮未提交或推送 Git；随包集成阶段经插件管理器启用了当前 Web profile 的视觉策展，未改其既有 AFP 依赖或配置。

本地闭环及独立安装包已验证。来源和视觉模型使用受控 HTTP fixture，图片解码、方向规范化、裁剪、私有资源、领域提交、任务和 AgentLoop 使用实际实现；不能据此宣称真实来源可用、审美质量改善、供应商费用已验证或模型已训练。

## 结果与范围

| 项目 | 结果 | 决定性证据 |
| --- | --- | --- |
| 本包行为测试 | PASS | `node --import tsx/esm --test tests/*.test.ts`：107 通过、0 失败、0 跳过。 |
| Host、Client、tests 编译面 | PASS | 包内 `node scripts/check.mjs`，以及最终 `pnpm pack` 的 prepack 检查。根 solution 配置不代替三个编译面。 |
| 最新根构建 | PASS | `pnpm --config.verify-deps-before-run=false run build:artifacts`：10/10；随后 `run build:check`：2/2。 |
| 构建依赖及 jobs 停止行为 | PASS | `node node_modules/vitest/vitest.mjs run scripts/build.spec.ts packages/jobs/jobs/tests/archive-admission.spec.ts`：15/15。 |
| 真实 AgentLoop Session 回放 | PASS | `node node_modules/vitest/vitest.mjs run --config vitest.snapshot.config.ts -t visual-curator`：1/1；未运行其他 213 个场景。 |
| Session corpus 静态约束 | PASS | 同一配置运行 `scripts/session-snapshot-corpus.corpus.ts`：3/3。未修改共享 harness 或 normalizer。 |
| 独立 tgz | PASS | 最终包 prepack、12 个文件清单、隔离 profile 安装及实际启动均通过；无应用 bin、源码、tests、node_modules 或凭据。 |
| AFP | PASS | 与开始实施时保存的 189 个文件 SHA-256 逐一比较，差异为零；AFP Git diff 为空。 |
| OpenSpec | PASS | `openspec validate add-visual-curator-v1 --strict --json`：无问题。结构通过不等于全部验收场景通过。 |
| 文档静态检查 | PASS（组合命令） | 早前 `test:docs` 21/21；最后复查因内存错误为 16/21，其余五项串行重试全部通过。双语摘要已更新；`verify-config-catalog` 单独重试通过。 |
| 文本及改动范围 | PASS | 103 个文件通过严格 UTF-8、无 BOM/替换字符、LF 和单末尾换行检查；`git diff --check` 通过，首次验收时根跟踪改动仅五个登记文件；随包集成新增范围见下文。 |
| 文档站 | PASS（本地替代命令） | `node --max-old-space-size=4096 --no-opt --import tsx/esm website/build.ts` 完成页面渲染；随后 `verify-doc-site-fragments` 校验 5166 个内部片段引用及 205 个原始 Markdown 产物。默认命令的失败记录见下文。 |
| 全量逐场景审计 10.1 | PARTIAL | [逐要求映射](../../../custom-plugins/workspace/dsh-plugin-visual-curator/tests/acceptance-matrix.md) 保留未独立执行的组合场景；不将四个 T 脚本整体标为全部通过。 |
| 真实接口 10.5 | NEXT | 用户明确要求稍后补充来源、模型部署及授权样例，本轮不执行。 |

## 浏览器闭环

应用仅通过受支持的 `dsh --profile visual-curator-v1-final` 启动，叠加 `apps/web/tests/pin-browse-picker.overlay.yml` 和临时 fixture overlay。隔离 `DSH_HOME` 位于 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-baseline-770iJe/smoke-home`。fixture 为 [browser-plugin.ts](../../../custom-plugins/workspace/dsh-plugin-visual-curator/tests/fixtures/browser-plugin.ts)，仅替换外部 HTTP 响应；1500ms 延迟仅用于浏览器显示暂停、恢复和取消窗口，单元并发验收使用受控 barrier。

1. 创建“低饱和自然绿 fixture 最终验收”，导入实际 800×400 PNG，逐图确认整体正例及带图授权；分析只生成待确认建议。人工确认必要规则后固定 candidate，再发布 v1；发布后默认仍为空，另行“设为默认”才生效。
2. 创建 9:16、90×160 用途。搜索启动后实际显示“已暂停”，恢复后得到一张 90×160 合格成图，原图和成图分别可见。关闭页面及重新打开仍可读取结果。
3. 人工调整坐标后取消，任务数仍为 2，未新增判断。再次明确生成后得到真实派生图；另行查看原/成图并确认 `crop-confirmation`、勾选纳入学习，才产生裁剪监督。
4. 同一成图先接受、再改判拒绝；旧 accept 保留，当前 style-verdict head 为 reject，crop-confirmation head 独立存在，复核队列显示人工与模型分歧。
5. 确认同 family 的开发集划分，导出 crop JSONL。下载返回 200；父图、派生图、225×400 有效区域、反馈 ID、固定版本/用途/任务均存在，三个文本文件 SHA-256 与清单一致，references-only 未附带图片字节。Skill 下载包含 `SKILL.md`、资源清单和版本说明。
6. 对同一组固定开发图片比较 release 与未发布 candidate：去重后为 1 个输入、4 次视觉调用；没有独立人工标签的指标分母为 0、值为 unavailable，默认版本未改变。图片比较不提供独立裁剪质量的观测，相关指标保持 unavailable。
7. 390×844 下收起宿主侧边栏后，document 宽 390、工作台宽约 334.4，无页面横向溢出。创建风格弹窗自动聚焦输入；Escape 关闭后焦点回到“创建风格”。新人工裁剪任务标题使用中文；立即取消后状态为 cancelled，稍后复读仍为 0 个结果。

固定记录：style `style-38ba6fe0ce53c2174388b4851250aef5`；release `release-b8da1a10ce03582de456d3794fdbf51d`；usage `usage-df2ff38675bfd8f906606ce5b730ebb0`；search Run `45acb85c9fddbf1856fd43ca784fcf3686a2553a4fbf6e22a8f8356fb69dd116`；人工裁剪 Run `418a666be4223dabf881579a488b9ceebd4d82c0f83cdd0dcd51e580457b10f2`；取消 Run `4c1774d9df3e184e5f69bd25a4ad1d297d3e4d103aa41c5ce7c4d57cb126ef16`；split `split-c83d2a565051b2368218950b3758b5d4`；crop export `export-f762130a1a687750c48d3483899040d1`；Skill export `export-2c4f26e646a5bf700a08457f64cf0e1e`；evaluation `evaluation-6fdeb7d31ed07500e9fe1a498201b7f3`。

可审阅截图位于工作区忽略目录 `.playwright-mcp/visual-curator-final-mobile.png`、`.playwright-mcp/visual-curator-final-desktop.png`；操作和控制台日志同目录保存。截图只证明 fixture 页面，不代表实际参考图的审美质量。

## 已修复及保留的失败

- 裁图普通风格反馈原先错误携带 parent 的 viewEvidence，服务端正确拒绝；现在 pair 提交两图、crop-confirmation 提交父图与成图，其他 image 判断只提交本图。浏览器接受、改判和历史复读通过。
- 人工裁剪缺少 taskBrief 时，内部英文审核说明出现在任务标题；Client 现在发送当前语言的标题。评估内置限制说明也经 typed locale 显示。
- Session 所属辅助视觉请求通过既有 plugin record 写入原 Session；原 Session 缺失时，在外呼前拒绝。授权负例改为检查已保存 normalized 图片，不能依赖被正确禁止的视觉调用生成 crop。
- 初始录制 fixture 在 Windows 保留了临时目录的 JSON 反斜线，并遗漏首个 jobId 的关联标记。本场景仅统一真实目录文字的分隔符；首个工具返回 jobId 与其 `job/registered` 的已有 token 对齐，不泛化替换业务文本。共享 corpus 的三个静态约束及真实回放均通过。
- 初次 `doc-sync` 41 项通过、2 项失败：配置目录生成进程报 `Zone Allocation failed`，文档站进程异常退出。配置目录单独重试通过；文档站默认命令单独重试仍以 `3221225477` 退出。限制堆并关闭优化的替代命令通过，尚未确定两个条件中哪个单独起作用。`es2024` 和代码块语言提示来自未修改的现有站点工具链，仍会出现。
- 最后 `test:docs` 并行运行时，type-equiv、persistence-formats、repository-references、doc-refs、package-readme-summaries 五个进程异常退出；其余 16 项通过。随后仅串行重跑这五项，全部通过。只限制 4096MB 堆、仍开启优化的 `docs:build` 也在渲染完成后异常退出；它不能替代上述实际 exit 0 的构建记录。
- 运行中的 Web 页面遇到根客户端 bundle 重建时出现暂时 404、连接及 slot 错误；构建期间停止测试 Host，重新启动并加载后控制台为零错误。一次并行检查期间还出现 `ERR_INSUFFICIENT_RESOURCES`。保留原日志，不把这些尝试列为无错误通过。
- 临时测试 profile 一次重启遇到旧锁 PID 被 `conhost.exe` 复用。锁机制按已有规则拒绝接管；没有删除锁或终止该无关进程。记录的 PID 退出后，后续正常启动自动接管成功。单机 PID 复用时的保守拒绝仍是既有锁机制限制。

## 交付与回退

最终产物为 [dsh-plugin-visual-curator-0.1.0.tgz](../../../custom-plugins/workspace/dsh-plugin-visual-curator/dsh-plugin-visual-curator-0.1.0.tgz)，SHA-256 为 `6587071fe002f0640d1501b4b5c6f6bd07655cb59875d531654649259dfe0049`。独立安装阶段曾通过隔离 `visual-curator-pack-smoke` profile 验证运行时，实际注册八工具、5 个 Client slots、308 个英/中文键、2 个 metadata locale 键，图标存在；style-list 正常，模型调用为 0。安装器的 profile-local peer 告警未隐藏，实际 DSH resolver 启动和 schema 导入均成功。本次重新打包只更新 README 及其双语配对记录；已逐字节比对 tarball 中 9 个运行代码、manifest、配置、资源和许可文件，与前次实际安装的包一致。

变更集中在独立包、专属 Session fixture、当前 OpenSpec 目录、根 package/workspace/lock/build 登记，以及 CLI 安装依赖、app-boot 默认模板、Desktop 打包阶段和对应 Web/单元测试、双语文档。原有未跟踪文件保留；AFP 的源码、配置、资源和构建产物摘要均未变化。需要停用时关闭本 bundle（或仅关闭可选 tools feature）；风格回退通过显式切换旧 release。包不默认加入既有 profile，不改 agent loop，不安装生成的 Skill，不写 Home 指令，不发布 GitHub Release。

10.1 在逐场景矩阵补齐前保持未勾选，10.5 按用户要求延期；本 change 不归档。

## 随包集成验收

用户于 2026-10-23 确认采用 AFP 的随包安装方式，替代最初“仅独立安装”的范围限制。CLI 直接依赖本包，Desktop 在既有自定义包阶段打包；新 Web/Desktop profile 默认选择它。已有 profile 的 bundle 列表和 patch 不做自动迁移，关闭选择仍保留；插件管理器从安装依赖发现它，启用无需另装 profile 副本。headless、SDK 与 ACP 模板未改。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 定向测试 | PASS，124 项 | `node node_modules/vitest/vitest.mjs run packages/boot/app-boot/tests/profile.spec.ts apps/desktop/tests/project-manager.spec.ts apps/desktop/tests/package-target-stages.spec.ts apps/desktop/tests/prepare-package-set.spec.ts --maxWorkers 2`；修改前 4 项预期失败，补齐接入后通过。覆盖新默认、旧选择和 patch 保留、恢复、新包打包顺序、缺本地 tarball 拒绝及 sharp 作为外部依赖解析。 |
| 浏览器回归 | PASS，2 项 | `node node_modules/vitest/vitest.mjs run --config vitest.web.config.ts apps/web/tests/visual-curator-builtin.e2e.ts apps/web/tests/afp-builtin.e2e.ts`；先生成专属工作台预期，再在最新构建回放。无 profile 副本时启用、未配接口创建风格、停用/刷新/再启用数据保留、AFP 工作台可用，pageerror 与连接告警收集为空。新测试初次执行遇到 Vitest 无 Playwright matcher 及缺预期目录，已分别改用现有轮询断言和建立本场景目录后回放通过；定向 lint 的 JSON 解析返回类型诊断也已修复。 |
| 最新根构建 | PASS | `pnpm --config.verify-deps-before-run=false run build:artifacts` 10/10（65.21s），随后 `build:check` 2/2（19.25s）；修正测试返回类型后再次通过 2/2（11.14s），包含新增 Host 浏览器测试的聚合类型检查。 |
| 独立包 | PASS | `pnpm --config.verify-deps-before-run=false --dir custom-plugins/workspace/dsh-plugin-visual-curator pack --pack-destination .`；prepack 的三个 compiler face 与打包完成，12 个文件，摘要见上文。 |
| 静态检查 | PASS | 定向 oxlint、84 个包的依赖策略、286 个 Cordis 配置、3 组双语配对、2063 个 Markdown 换行及 2025 个 Markdown 引用；严格 OpenSpec 校验通过。 |
| AFP 范围 | PASS | 对比随包集成开始时的 189 个文件 SHA-256，含重新构建的产物，全部一致；对应记录在 `C:/Users/zhuyi/AppData/Local/Temp/visual-curator-builtin-drT1d9/baseline.json`。 |

当前用户 Web 在本轮安装依赖变更前已启动。Playwright MCP 在其插件管理页确认视觉策展显示“代码来源：内置”，并保存启用选择；旧 Host 中组件仍未运行，刷新页面未出现入口，因此需重启该 Host 才能采用新的安装解析表。没有终止用户 Web。该页面另有启动时的既有工作区路径解析告警，涉及 Downloads 路径重定向；不在本次插件改动范围内。上述隔离浏览器场景的新 Host 没有该告警。

本次验证随包依赖、profile 及打包输入链路，不代表已生成或发布签名 Desktop 安装器；未执行真实图片来源/视觉接口。原 10.1 未逐项执行场景与 10.5 真实接口延期继续保留。

通过受支持的 `dsh --profile visual-curator-builtin --from-default-profile web --dump-config`，在独立 `DSH_HOME` 创建新 profile 并检查实际解析结果：默认包含 AFP、视觉策展、侧栏及更新器，`dependencies` 为空，`visual-curator`、`visual-curator-tools` 和 `afp` 三行均存在。dump 保存在上述随包集成临时目录；未启动额外 Host。最终浏览器测试复用已有插件切换等待预算，避免使用默认 1 秒轮询限制；复验 1/1 通过。最终任务状态为 50/52，未完成项仍为原 10.1 和 10.5。

修改文件与回退：CLI 的 `apps/cli/package.json` 和 lockfile 增加安装依赖；app-boot 的 `src/profile.ts` 及测试、README 双语配对定义新旧 profile 行为；Desktop 的 `scripts/package-target.ts` 与三个定向测试加入打包输入并验证闭包；Web 的 `tsconfig.json`、`tests/visual-curator-builtin.e2e.ts` 与对应 expected 记录实际交互；自定义插件索引、包 README/验收映射及当前 OpenSpec 记录同步范围。原先已存在的根 workspace/build/Session fixture 改动保留。停用可通过插件管理器关闭视觉策展，数据保留；代码回退只撤销本轮新增行，原始跟踪文件来自 Git HEAD，已有脏文件的逐文件备份在随包基线目录 `before/`，不得整体 reset 工作区。
