# Desktop 更新下载测量

[English](README.md) | 中文

## 概述

Windows 的公开完整安装包使用 Electron 的有界并行 Range 请求。Motrix 内核已作为候选下载、校验、运行并实测，本次不随产品分发。[测量数据](results-2026-11-03.json)区分成品传输层、原型、完整下载和中断样本。这些结果只描述 2026-11-03 这台 Windows 电脑及所测线路。

## 目录

- [引擎选择](#engine-choice)
- [测量结果](#measurements)
- [恢复与完整性](#recovery-and-integrity)
- [复现与验证](#reproduce-and-qualify)
- [限制与回滚](#limits-and-rollback)

<a id="engine-choice"></a>

## 引擎选择

官方 [Motrix 2.2.0](https://github.com/agalwood/Motrix/releases/tag/v2.2.0)固定使用 [aria2 1.37.0-motrix.21](https://github.com/agalwood/Motrix/blob/v2.2.0/scripts/engine.lock.json)。[MDXP](https://github.com/motrixapp/mdxp)是 JSON-RPC 客户端协议，不是传输引擎。独立内核报告支持 SQLite3-Persistence，许可证为 GPL-2.0-or-later，并具有源码中的 OpenSSL 链接例外；不能用 Motrix 应用的许可证替代内核许可证。

| 方案 | 传输与状态归属 | 分发与维护 |
| --- | --- | --- |
| A：通过 MDXP 调用已安装 Motrix | 依赖另一应用的配对、配置、队列、可用性及持久化 | 不内置内核，但需要额外安装应用并接入其任务生命周期；未连接用户的 Motrix 做联调 |
| B：内置私有 Motrix aria2 | 部分线路吞吐量较好；自行管理连接、SQLite 进度、RPC、进程退出、代理及证书配置 | 官方 x64 ZIP 为 4,618,529 字节，可执行文件为 11,426,816 字节，尚不含再分发材料；增加生命周期、打包和代理适配工作 |
| C：Electron Range 传输 | 较早的检查点实现在所测 GHFast 线路上使用四个工作连接提速，同时保留 Electron 的代理、PAC、证书与 updater 协调 | 无新增原生二进制或依赖；独立记录并校验区间检查点；本次选择 Windows 使用此方案 |

实测使用的[官方 x64 压缩包](https://github.com/motrixapp/aria2/releases/tag/v1.37.0-motrix.21) SHA256 为 `cc3925dba967b6a5fc5c33c5f5bbe81f14ca436f5970b03a5043a11741b5c41c`，解压后程序 SHA256 为 `0e692a88146d5eb12ec0c3fe3de2055812b01c5c80147a6e88ecd51985ab5dd6`。程序报告依赖 zlib 1.3.2、expat 2.8.3、SQLite 3.53.4、OpenSSL 3.5.8、c-ares 1.34.8 和 libssh2 1.11.1。ZIP 内只有可执行文件；产品再分发还需准备适用的许可证、声明和对应源码安排。本次不再分发任何内核资产。

该分支的 `--enable-sqlite3-persistence` 替代文本 Session 和每个下载的 `.aria2` 控制文件，数据库及 WAL 保存分片位图与在途进度。Motrix 在 SQLite 模式下使用不同的保存周期。该分支明确加载 Windows ROOT 证书，因此并非必须另配 CA 文件；这仍不等于继承 Electron Session 的专用代理及证书策略。Motrix 应用自身另有代理路由、SOCKS 桥接及 CA 导出实现。测速使用私有回环 RPC、随机令牌、独立 SQLite、严格 TLS 和显式系统／内置 CA 集合，从未连接其他 Motrix 实例。结合这些集成成本、C 的实测收益，以及没有证据证明某个引擎在所有线路上占优，本次选择 C；数据不证明 C 总比 aria2 快。

<a id="measurements"></a>

## 测量结果

环境为 Windows 11 build 26200、Intel Core i5-14400、16 个逻辑处理器、NTFS、Node 24.14.0、Electron 44.7.0。公网文件是 `0.2.2-alpha.2.20261103.2` 的官方 Windows 安装包，大小 408,869,724 字节。各场景顺序运行，应用缓存与目标文件独立。OS、DNS／TLS 和 CDN 缓存共享且不可控，后续轮次不能视作相同冷缓存。JSON 中的公网负载总量不含协议开销及部分早期诊断，因此是测试流量的下界。

以下有时间上限的公网样本使用较早、保存频率较低的检查点实现，不能代表最终保存频率下的吞吐量。

| 配置工作连接数 | Electron GHFast，正序，MiB/s | Electron GHFast，倒序，MiB/s | aria2 GHFast，倒序，MiB/s |
| --- | --- | --- | --- |
| 1 | 0.69 | 2.71 | 0.29 |
| 4 | 2.12 | 4.80 | 1.86 |
| 8 | HTTP 429；保留已收字节 | HTTP 429；保留已收字节 | 2.98 |
| 16 | HTTP 429；保留已收字节 | HTTP 429；保留已收字节 | 1.74 |

Electron 的预算为每轮 30 秒；限流场景提前结束，不在同一源重试。aria2 的预算为 15 秒，最小拆分为 1 MiB，实际连接可能少于配置的拆分数。预算和动态拆分不同，不能据此精确排列两个引擎的速度。Electron 同线路对比支持四个工作连接，429 响应则不支持将八或十六设为默认。另一次 GH-Proxy 测量未体现可靠的并发收益，速度约为 0.12–0.35 MiB/s。已记录的公网有效载荷流量累计至少为 1,710.66 MiB。早期不限制请求区间大小的原型在十六连接时达到过 5.02 MiB/s，该结果不用于声称成品提速。

较早的有界区间实现完成一次 GHFast 全文件下载耗时 119.93 秒：传输 118.17 秒，首字节 0.82 秒，整文件 SHA512 1.61 秒，最终复制 0.14 秒，检查点累计工作耗时 0.42 秒。所有字节通过官方大小与 SHA512 校验。此轮使用前一版 `session.fetch` 适配器。通过代理认证适配器再次完整下载耗时 247.79 秒（1.57 MiB/s）：传输 244.74 秒、首字节 1.10 秒、检查点 0.41 秒、SHA512 2.86 秒、复制 0.18 秒，此轮也早于最终检查点频率。这种波动限制了对引擎速度的结论；两次均按官方清单校验全部字节。更早的自动选源样本在传输前花费 3.63 秒测速，但未保留所选线路 ID，因此不作为并发收益证据。

最终实现提高检查点保存频率，使活动连接合计约 1 MiB 以内的数据尚未记入检查点。使用 Electron 对 64 MiB 回环文件各运行两轮，单连接平均 584 ms，四连接平均 1,295 ms；检查点累计工作耗时分别为 112／899 ms，SHA512 为 348／339 ms，复制为 24／30 ms，平均峰值 RSS 为 252／260 MiB。检查点时间按工作连接相加，可能存在重叠。四连接在这个本地场景更慢；后台活动和文件系统暖缓存会影响短样本，不能预测公网吞吐量。JSON 中较早的 Node 和 Electron 回环数据采用前一版检查点频率。最终实现使用 GHFast 的 1、4、8、16 连接复测均在收到数据前报 `net::ERR_CONNECTION_TIMED_OUT`。

最终实现还从 GitHub 原始地址测量同一个官方安装包，各配置使用独立应用缓存并限时 30 秒。1、4、8、16 个连接分别收到 3,097,474、3,406,846、2,456,634、2,859,233 字节，速度分别为 0.098、0.108、0.078、0.091 MiB/s。这些样本顺序运行，均未完成整包下载，网络及系统缓存状态不可控，期间还有本机构建和文档检查；收到的应用负载合计 11,820,187 字节。所测线路上八或十六连接没有可靠优势，四连接的小幅差异也不足以证明普遍提速。最终检查点频率下的公网完整下载耗时仍未测量。

CPU、RSS 和事件循环只覆盖测速主进程，不覆盖 Chromium 网络进程、aria2 CPU 或整机。已测量磁盘同步、检查点、哈希与复制耗时，未测量物理磁盘 IOPS 或完整线上流量。较早的完整公网场景主进程 CPU 用量为 4.49 秒，峰值 RSS 210 MiB，事件循环 p99 为 20.94 ms，最大值 25.20 ms。较早的代理认证适配器完整下载主进程 CPU 用量为 8.12 秒，峰值 RSS 170 MiB，事件循环 p99 20.69 ms，最大值 50.66 ms。这是调度测量，不是完整输入响应时延。

<a id="recovery-and-integrity"></a>

## 恢复与完整性

[Desktop 传输说明](../../README.zh.md#local-updater-qualification)维护缓存文件名及配置。恢复时逐区间计算摘要，只重新请求变化或缺失的区间，不信任稀疏文件的分配长度。导入旧缓存时校验原前缀，再复制到独立负载文件，并保留旧前缀及检查点。单个下载对象限制工作连接数，等待请求、写入和检查点保存结束后才换源或完成暂停。暂停及普通失败会保存部分区间；异常退出只复用已记录的字节。

原生差分、认证下载及元数据不完整的下载继续使用原生路径。整个磁盘文件通过大小和官方 SHA512 校验后，原生准备才可能报告就绪。关闭下载窗口不会暂停下载或授予安装权限。代理认证转发到已有 updater login 事件，本次不增加凭据输入窗口，也不向公共镜像转发源站认证或账号 Cookie。

<a id="reproduce-and-qualify"></a>

## 复现与验证

安装工作区依赖后，在仓库根目录运行：

```sh
node apps/desktop/scripts/measure-update-download.mjs
node apps/desktop/scripts/test-local-updater.mjs
node apps/desktop/scripts/test-update-download-package.mjs
```

第一条命令打包当前传输层，通过 Electron 运行两轮 64 MiB 回环测试。可选参数 `--artifact <json>` 读取受信更新清单中的 `url`、`version`、`size` 和 `sha512`；`--source ghfast --connections 1,4,8,16 --rounds 2 --budget-ms 30000` 进行有时间上限的公网比较。预算为零表示等待完成。HTTP 失败与定时暂停分别记录。输出、userData、缓存和日志均使用独立的 `.desktop-build/qualification/download-performance-*` 目录。另外两条命令验证实际 Electron／NSIS 准备流程，以及独立、无签名的 Windows x64 ASAR 传输应用。ASAR 应用使用不可执行的测试内容，不包含外部下载内核，也不是完整产品安装器。

<a id="limits-and-rollback"></a>

## 限制与回滚

聚焦测试覆盖并发下载拒绝、精确并行区间、暂停、换源、检查点恢复、缓存字节变化、旧缓存转换、不支持 Range、错误／截断／编码响应、哈希拒绝、403／429、停滞、慢源切换、断网及检查点失败。真实 Electron 另覆盖固定／PAC／认证代理、Cookie 隔离、不可信证书拒绝、进程强制退出及重启、实际位置写入部分字节后注入 ENOSPC、后台关闭再打开、原生准备及单独安装授权。截图失败独立报告，显示表面不可截取不代表视觉验收通过。

实际磁盘耗尽、突然断电、企业 NTLM／Kerberos 与复杂 PAC 部署、干净电脑的完整产品安装、线上无签名安装包的发布者签名验证，以及 macOS 行为仍未验证。aria2 启动及崩溃恢复不是本次产品路径。发布渠道、实际安装版本比较、语言选择和安装策略仍归已有协调器及桌面壳所有。

插件安装包复用同一区间传输，使用官方 SHA256；其现有 Node 代理策略与 Electron 网络行为分别保留。

设置 `DSH_DESKTOP_UPDATE_CONNECTIONS=1` 并重启，可关闭并发同时继续读取新区间缓存。代码回滚只撤销本任务的传输、测试及说明，保留工作区其他改动。保留区间文件：旧二进制无法读取它们，只能续传保留的旧连续前缀；恢复区间读取器后可继续使用新进度。不要将稀疏区间负载改名为 `payload.part`。
