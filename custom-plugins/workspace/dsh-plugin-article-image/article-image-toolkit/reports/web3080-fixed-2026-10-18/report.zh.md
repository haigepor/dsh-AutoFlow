# 3080 工作台修复与28篇复测（2026-10-18）

[Observed] 最终验收 **PASS**。通过3080工作台实际全选28篇并点击处理，21篇生成本次新快照；6篇返回 article-restricted，1篇 article-short，通用失败0。正文块及嵌套列表对照既有核心语料无缺失，修复前97张就绪原图保留97/97；快照封装、语义哈希及全部资产长度/SHA256逐一校验。2篇视频来源仍为partial，不代表完整视频文字输入。没有调用真实模型审批或生图。

## 修复依据与行为

[Observed] [列表](../../../src/host/workflow-service.js#L63)直接使用单次索引视图生成摘要，保留不可变快照校验，不再逐项调用detail、重复读取全量索引或加载无关分析记录。受控28项测试要求索引读取29次→1次，并覆盖损坏的无关分析记录不阻塞列表。

[Observed] [Store](../../../src/host/store.js#L65)在实例内先串行入队，再取得原有跨进程文件锁；异常事务不发布、不污染后续写入。[进度批次](../../../src/host/run-progress.js#L5)按16条/200ms合并并保留事件发生时间，终态等待排空。写入失败会中止本次抓取并保留原异常，不能发布伪成功快照。真实文件锁测试覆盖两个实例及独立子进程；没有延长2秒锁等待或删除跨进程保护。

[Observed] [根因分类](../../../src/host/run-diagnostics.js#L9)保留operation、causeCode、errorType及最多5层受控cause类别；文件权限、锁超时与网络/DNS/TLS失败不再只剩operation-failed。默认诊断不保存任意异常文本、路径、Cookie或凭据。进度写入注入EPERM的集成测试确认抓取中止，诊断保留progress-write/fs-eperm，且不进入模型调用。

[Observed] [原图传输](../../src/capture-media.js#L72)复用篇级连接，按origin和已验证公网地址集合隔离，每次请求和跳转重新校验；导航与普通请求保持独立。篇级图片解码器复用禁止联网的空白context/page，取消/dispose等待请求与解码清理。仅临时网络失败或超时按配置重试同一候选，默认1次；失败预算照扣，HTTP拒绝、解码失败、策略拒绝与取消不重试。首次解码器启动失败保留文字和失败图片位置。

[Inferred] 这些修改消除了报告中已复现的重复读取、同实例写锁竞争和异常信息压缩路径。原始5次通用失败未保存完整异常，不能倒推每一次都是锁超时；最终同批次5篇均直接完成获取才是稳定性验收证据。

## 两次修复后批量的独立结果

| 批次 | 全部入队到终态 | 新快照 | 原图哈希保留 | 验收 |
|---|---:|---:|---:|---|
| 原3080测试首轮 | 1282.6秒 | 16/28 | R7首次封面丢失 | FAIL |
| 本次修复后第一轮 | 1076.9秒 | 21/28 | 96/97 | FAIL |
| 本次补充修复后最终轮 | 874.4秒 | 21/28 | 97/97 | PASS |

[Observed] 第一轮CNN第9张原图60秒超时后回退到了小图：2624×3936、2,043,264字节变为1365×2047、406,637字节。即使图片总数仍为97，仍判定FAIL；补充同候选有界重试后完整重新执行28篇，没有以单篇重试覆盖失败批次。本轮实际记录同候选重试1次；CNN在11/13完成后的b49图片出现article-network，同候选重试1次后取回原字节；事件保存在逐篇进度中，网络样本与受控失败测试分开解释。

## 最终28篇逐项耗时

单位为秒，段/标题/列表是顶层块数量，列表项及嵌套结构另逐字段核验；原图按篇内唯一资产统计，重复展示位置不重复计数。所有失败条目均不把旧快照计为本轮成功。

| # | 站点 | 结果 | 排队 | 执行 | 渲染 | 抽取 | 媒体 | 段/标题/列表 | 就绪/失败图 |
|---|---|---|---:|---:|---:|---:|---:|---|---|
| 1 | www1.folha.uol.com.br | article-restricted | 0.0 | 79.7 | 73.7 | — | — | — | — |
| 2 | www1.folha.uol.com.br | article-restricted | 0.1 | 80.0 | 77.8 | — | — | — | — |
| 3 | www1.folha.uol.com.br | article-restricted | 80.2 | 40.0 | 38.3 | — | — | — | — |
| 4 | www.metropoles.com | partial | 80.3 | 39.9 | 23.8 | 2.0 | 8.2 | 24/5/0 | 2/1 |
| 5 | www.correiobraziliense.com.br | needs-review | 120.3 | 27.0 | 21.5 | 0.6 | 3.6 | 2/1/1 | 1/0 |
| 6 | www.correiobraziliense.com.br | needs-review | 120.3 | 27.7 | 24.4 | 0.4 | 2.8 | 13/1/0 | 1/0 |
| 7 | www.otempo.com.br | needs-review | 147.3 | 69.7 | 61.0 | 2.1 | 6.4 | 16/7/0 | 8/0 |
| 8 | guia.folha.uol.com.br | needs-review | 148.0 | 95.2 | 50.8 | 2.1 | 39.7 | 40/3/0 | 20/0 |
| 9 | www1.folha.uol.com.br | article-restricted | 217.0 | 38.7 | 36.4 | — | — | — | — |
| 10 | guia.folha.uol.com.br | needs-review | 243.2 | 185.0 | 44.3 | 6.0 | 133.5 | 28/14/0 | 20/0 |
| 11 | g1.globo.com | needs-review | 255.8 | 49.2 | 39.7 | 1.2 | 7.9 | 19/3/1 | 4/0 |
| 12 | www.gov.br | needs-review | 305.0 | 48.9 | 34.3 | 0.9 | 12.5 | 25/1/3 | 3/0 |
| 13 | www1.folha.uol.com.br | article-restricted | 353.9 | 63.7 | 63.1 | — | — | — | — |
| 14 | www1.folha.uol.com.br | article-restricted | 417.7 | 72.7 | 68.6 | — | — | — | — |
| 15 | canaltech.com.br | needs-review | 428.2 | 52.7 | 34.9 | 0.7 | 15.6 | 31/9/1 | 9/0 |
| 16 | www.cultura.sc.gov.br | needs-review | 481.0 | 26.1 | 20.7 | 0.4 | 4.9 | 13/1/1 | 1/0 |
| 17 | www.lance.com.br | needs-review | 491.1 | 26.4 | 19.3 | 0.3 | 6.5 | 10/1/0 | 2/0 |
| 18 | www.gov.br | needs-review | 507.1 | 39.7 | 32.4 | 1.0 | 4.9 | 5/1/0 | 1/0 |
| 19 | www.cnnbrasil.com.br | needs-review | 517.6 | 171.6 | 29.7 | 3.1 | 138.4 | 36/6/0 | 13/0 |
| 20 | www.correiobraziliense.com.br | needs-review | 546.8 | 42.0 | 28.7 | 0.4 | 8.6 | 15/2/1 | 3/0 |
| 21 | record.r7.com | partial | 588.8 | 57.5 | 55.4 | 0.8 | 1.2 | 7/2/0 | 1/0 |
| 22 | www.estadao.com.br | needs-review | 646.3 | 42.5 | 32.6 | 0.7 | 8.8 | 43/4/1 | 3/0 |
| 23 | www.bcb.gov.br | article-short | 688.9 | 67.7 | 64.1 | — | — | — | — |
| 24 | www.bcb.gov.br | needs-review | 689.2 | 74.0 | 72.2 | 0.5 | 0.0 | 8/0/0 | 0/0 |
| 25 | www.bcb.gov.br | needs-review | 757.7 | 56.8 | 55.9 | 0.6 | 0.0 | 1/0/0 | 0/0 |
| 26 | www.gov.br | needs-review | 763.3 | 41.0 | 30.8 | 0.9 | 8.9 | 11/1/0 | 2/0 |
| 27 | www.gov.br | needs-review | 804.3 | 48.6 | 40.0 | 0.8 | 7.7 | 14/1/0 | 1/0 |
| 28 | www.gov.br | needs-review | 814.5 | 59.9 | 38.6 | 0.7 | 16.5 | 8/1/0 | 2/0 |

## 耗时解释

[Observed] 最终整批874.4秒，执行中位数50.9秒，排队中位数423.0秒；并发保持2。与原1282.6秒相比变化31.8%。这是同机真实网络单次样本，保留现有匿名会话及用户其他标签页，不是受控冷启动基准；不能把总差值全部归于代码。

| # | 原媒体秒 | 最终媒体秒 | 其中下载秒 | 其中解码秒 | 保存原图字节 |
|---|---:|---:|---:|---:|---:|
| 8 | 94.2 | 39.7 | 30.4 | 9.3 | 1516057 |
| 10 | 319.4 | 133.5 | 99.0 | 34.4 | 90308857 |
| 19 | 88.6 | 138.4 | 125.2 | 13.1 | 29951198 |

[Observed] downloadMs/decodeMs仅计传输和真实解码累计时间，媒体阶段还包含候选处理、进度提交与事件间等待。chargedBytes是含失败尝试预占的预算扣除值，不是实测网络流量。部署上限保持每图24,000,000字节、每篇160,000,000字节，未改为MiB或降低原图大小。

[Observed] 最终批量窗口混合data API 507次，中位1255.7ms、P90 2657.0ms、最大7153.7ms；原首轮为543次、中位1526.3ms、P90 3283.9ms、最大14817.7ms。两者均混合status/list/detail，不能称为纯列表延迟。后台空闲3轮列表分别35.8/35.2/34.6ms，首篇受限文章detail分别12.9/13.9/14.0ms；样本很小，保留普通轮询，不代表冷启动。实际DOM确认Correio的7个列表项、Guia的72块/30图片位置/20唯一原图、CNN的55块/13原图；最大原图经3080接口返回JPEG 15,521,071字节、3360×5040，读取/哈希/解码1336.5ms，控制台错误和警告均为0。完整测量见results.json。100ms文件观察器的连续锁可见区间可能合并多个写者，不将区间长度解释为单次写盘时长。

## 质量、展示和限制

[Observed] 逐篇正文/列表差异、原图哈希保留、资产完整性及sourceHash差异见verification.json。R7播放器标题/作者标签与Estadão图片alt可能随公开页面变化；这些元数据差异单独列出，不宣称所有语义哈希恒等。现有核心文字和列表必须全部保留才通过。

[Observed] 6篇Folha访问限制不绕过；BCB短公告不充当完整文章；Metrópoles仍有1张跨源跳转视频封面不可取，R7未提供完整可获取视频文字。两篇partial保留既有照片/封面和公开文字，后续仍需人工确认。

## 检查与回滚

[Observed] 工具包26个文件386项测试、插件17个文件157项测试、实际Web集成测试及其记录快照通过；build:client和插件check通过。早期两套测试并行时，旧生命周期取消用例出现一次失败；当时输出只保留ok=false，未查明根因。补充断言诊断后，焦点与后续完整工具包复跑均通过，未修改该用例行为或超时。

[Observed] 改动清单及原文件前后哈希见scope.json；本轮对照修复前15274份文件，范围外变化0项，原profile patch保持一致。既有未提交改动未回退。本次备份位于本机临时目录article-web-fix-zYPaal/before，另有state.before.json、cordis.before.yml；回滚仅恢复本轮修改文件，移除本轮新增文件，旧读取器降级须恢复升级前完整profile备份。

修改文件：

- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-media.js`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-renderer.js`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture.js`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/diagnostics.js`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/test/lifecycle-foundations.test.js`
- `custom-plugins/workspace/dsh-plugin-article-image/src/host/run-diagnostics.js`
- `custom-plugins/workspace/dsh-plugin-article-image/src/host/workflow-service.js`
- `custom-plugins/workspace/dsh-plugin-article-image/tests/workflow-v2.test.js`
- `docs/upgrade-guide/v0.2.0-rc.2/article-image-workflow/guide.i18n.yaml`
- `docs/upgrade-guide/v0.2.0-rc.2/article-image-workflow/guide.md`
- `docs/upgrade-guide/v0.2.0-rc.2/article-image-workflow/guide.zh.md`
- `apps/web/tests/__snapshots__/article-image.e2e.ts.snap`
- `apps/web/tests/article-image.e2e.ts`
- `custom-plugins/workspace/dsh-plugin-article-image/README.i18n.yaml`
- `custom-plugins/workspace/dsh-plugin-article-image/README.md`
- `custom-plugins/workspace/dsh-plugin-article-image/README.zh.md`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/README.i18n.yaml`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/README.md`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/README.zh.md`
- `custom-plugins/workspace/dsh-plugin-article-image/client.js`
- `custom-plugins/workspace/dsh-plugin-article-image/config-schema.js`
- `custom-plugins/workspace/dsh-plugin-article-image/src/client/locales/en.json`
- `custom-plugins/workspace/dsh-plugin-article-image/src/client/locales/zh.json`
- `custom-plugins/workspace/dsh-plugin-article-image/src/host/service.js`
- `custom-plugins/workspace/dsh-plugin-article-image/src/host/store.js`
- `custom-plugins/workspace/dsh-plugin-article-image/src/shared/contracts.js`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/reports/web3080-fixed-2026-10-18/report.zh.md`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/reports/web3080-fixed-2026-10-18/results.json`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/reports/web3080-fixed-2026-10-18/scope.json`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/reports/web3080-fixed-2026-10-18/verification.json`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/test/capture-performance.test.js`
- `custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/test/image-transport-retry.test.js`
- `custom-plugins/workspace/dsh-plugin-article-image/src/host/run-progress.js`
- `custom-plugins/workspace/dsh-plugin-article-image/tests/run-progress.test.js`
- `custom-plugins/workspace/dsh-plugin-article-image/tests/workbench-io.test.js`
