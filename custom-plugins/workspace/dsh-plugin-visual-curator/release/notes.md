## Visual Curator 0.2.8

- Collect 50/100 unique candidates across pages, screen batches of actual thumbnails, then fully review retained and uncertain candidates. Only full review qualifies an image; originals download after screening.
- Reuse committed batches after pause or restart. Screening failures retry within the same budget before individual full-review fallback. Known references and rejected photos are skipped before downloading, and saved feedback guides later query pages.
- Preserve valid negative-only rules and required exclusions within shared or alternative-group scope. Fix rejected source images being reviewed again after rewording a task or switching models. Technical failures and uncertain images remain retryable.
- Configure pool size, batch count and thumbnail resolution in model settings. Task cards show separate screening and full-review counts; disable screening to restore individual reviews for new tasks.

A bounded live comparison used the same 12 public images, native model and synthetic car/environment rules: 12 model calls and 98.976 seconds became 6 calls and 80.904 seconds. Both paths accepted one image; that baseline match was not discarded. This single sample does not establish a general speedup or false-rejection rate. The package includes the bilingual search-performance report and an opt-in diagnostic remains in the repository.

Update the plugin and restart AutoFlow after current tasks finish; no desktop reinstall is needed. Existing tasks and datasets retain their frozen content. To recover negative rules omitted by older versions, choose All roles → Reuse and organize and use the new complete dataset. Compatible observations are reused; exporting the old profile alone does not restore rules. Explicitly disabled rules remain disabled. Automatic installation stays opt-in and does not restart the application.

## 视觉策展 0.2.8

- 跨页积累 50/100 个唯一候选，使用真实缩略图分批初筛，再完整复核保留及不确定图片。只有完整复核才能入选，原图在初筛后下载。
- 暂停或重启复用已提交批次，初筛失败在同一预算内有限重试，再转逐图完整复核。下载前跳过已知参考图和拒绝照片，后续翻页优先采用已有复核反馈较好的关键词。
- 保留有效的仅反例规则及共享或备选组中的 required 排除，修复改写需求或切换模型后重复复核已拒绝源图的问题。技术失败和不确定图片仍可重试。
- 模型设置可调整候选池、每批数量和初筛分辨率，任务卡分别显示初筛及完整复核数量。关闭初筛可让新任务恢复逐图完整复核。

一次有界真实对比使用相同的 12 张公开图片、原生模型和合成汽车及环境规则：模型调用从 12 次减为 6 次，耗时从 98.976 秒降为 80.904 秒，两条路径均通过一张，该基线匹配图未被初筛排除。单次样本不能推导普遍提速或错杀率。发布包包含双语搜图性能报告，仓库保留须显式启用的诊断夹具。

当前任务结束后更新插件并重启 AutoFlow，无需重新安装桌面包。已有任务和数据集保持固定内容；旧版遗漏反例规则时，选择“全部角色 → 复用并整理”，使用新生成的完整数据集。兼容观察直接复用，仅导出旧画像不能补回规则；用户明确关闭的规则不会自动开启。自动安装仍须明确开启，不会自动重启应用。
