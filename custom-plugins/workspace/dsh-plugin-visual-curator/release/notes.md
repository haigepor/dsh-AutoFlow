Visual Curator 0.2.1

Native reference analysis delegates request timing to the selected native LLM adapter, removing plugin single-request and task wall-clock deadlines from that path, including failed-task continuation. Cancellation, native connection/idle handling, call and byte budgets remain. Image downloads, search, crop and compatible HTTP requests retain their existing time limits.

原生参考分析交给所选原生 LLM 适配器管理请求时序，取消该路径上插件叠加的单次请求及任务总时限，继续失败任务时同样生效。取消、原生连接与空闲处理、调用及字节预算继续有效；图片下载、搜索、裁剪与兼容 HTTP 请求保留原有时限。

Style-summary v3 uses short image labels with a recorded canonical dictionary and restores every validated evidence and group reference before saving. Streaming analysis retains received readable content and a stable JSON view after bounded text truncation, preserving latest-output following and historical reading positions.

风格归纳 v3 采用图片短代号并记录原始身份字典，保存前还原全部证据和分组关联。流式分析达到文本保留上限后，保持已收到的可读内容与稳定的 JSON 视图，保留跟随最新输出及历史阅读位置。

Install or update from the plugin page, then restart AutoFlow. Existing profile configuration, credentials, saved styles, references, tasks and feature selections remain. No migration is required. Automatic installation is opt-in and does not restart the application. Assets contain the exact-source tarball, checksum list and update metadata. Live source login, paid vision requests and image permissions require separate acceptance.

在插件页安装或更新后重启 AutoFlow，保留已有 profile 配置、凭据、风格、引用、任务和功能选择，无需数据迁移。自动安装需明确开启，不会自动重启。资产包含精确源码 tarball、校验列表与更新元数据。真实来源登录、付费视觉请求与图片权限须另行验收。
