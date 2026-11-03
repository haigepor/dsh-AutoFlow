Visual Curator 0.2.2

Reference analysis, image-search reviews, crop proposals, evaluation and context compaction delegate timing to the selected native LLM adapter. Native tasks no longer have plugin-imposed single-request or task wall-clock deadlines, including continuation of saved tasks. Cancellation, native connection/idle handling, call/page/byte quotas and bounded retries remain effective. Image-source and image-download requests retain network timeouts; explicitly selected compatible HTTP tasks retain their existing time limits.

参考图分析、找图复核、裁剪提案、评估和上下文压缩统一交给所选原生 LLM 适配器管理请求时序。原生任务不再叠加插件的单次请求和任务总时限，继续已保存任务时同样生效。取消、原生连接与空闲处理、调用次数、搜索页数、字节额度和有限重试继续有效。图库检索和图片下载保留网络超时；明确选择的兼容 HTTP 任务保留原有时限。

The conversation card cancels an outdated detail read when the task directory reports a newer status, then reads the current results. Stalled requests no longer block terminal updates, and late running responses cannot replace the refreshed completed state.

任务目录报告更新的状态时，会话卡片撤回旧详情请求并读取当前结果。停滞请求不再阻挡终态更新，迟到的“进行中”响应也不能覆盖已刷新的结束状态。

Install or update from the plugin page, then restart AutoFlow after current tasks finish. Existing profile configuration, credentials, saved styles, references, tasks and feature selections remain. No migration is required. Existing technical failures are retained and are not automatically retried as paid model requests. Automatic installation is opt-in and does not restart the application. Assets contain the exact-source tarball, checksum list and update metadata. Live source login, paid vision requests and image permissions require separate acceptance.

在插件页安装或更新，待当前任务结束后重启 AutoFlow，保留已有 profile 配置、凭据、风格、引用、任务和功能选择，无需数据迁移。原有技术失败记录保留，不会自动发起付费模型重试。自动安装需明确开启，不会自动重启。资产包含精确源码 tarball、校验列表与更新元数据。真实来源登录、付费视觉请求与图片权限须另行验收。
