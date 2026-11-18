## Visual Curator 0.2.30

- The first outpainting request uses the positioned canvas as the framing reference. The original image supplies appearance details, and the safety overlay supplies layout guidance.
- Safety-area confirmation annotates the actual finished image to keep the measured edges in the output coordinate system.
- Final review measures a faithfully preserved action prop relative to the accepted subject scale. Missing parts, visible truncation and safety-area violations still block acceptance.

Prepared for AutoFlow Desktop 0.2.2-rc.3.20261119.2.

## Visual Curator 0.2.30 更新说明

- 首轮扩图按规划画布定位。原图用于核对外观，标注图用于核对安全区。
- 安全区确认直接在同一张成品画面上叠加标注，避免复用原图和规划图的坐标。
- 复审根据合格主体的实际缩放评估完整保留的动作道具。缺失、明显截断和安全区越界仍会阻止通过。

已为 AutoFlow Desktop 0.2.2-rc.3.20261119.2 准备。

## Visual Curator 0.2.29

- Queue a failed image for retry while the batch continues. Its saved step resumes after the running images finish. Pausing holds queued retries until the batch resumes.
- Replace or cancel one image, or apply a revised plan to it. The other images keep their saved progress and results. Switching images keeps previews and history tied to the selected source.
- Choose All to load the remaining server image pages with visible progress. The table checkbox selects eligible images after the list finishes loading.

Prepared for AutoFlow Desktop 0.2.2-rc.3.20261119.1. Restart after active tasks finish to load the matching Host and Client.

## Visual Curator 0.2.29 更新说明

- 批次运行时可为失败图片登记重试。正在处理的图片完成后，系统从该图已保存的步骤继续。暂停批次会保留排队中的重试，继续批次后恢复。
- 替换、取消处理或应用修订后的规划只作用于选中的图片。其他图片保留已保存的进度和成品。切换图片时，预览和历史跟随选中的原图。
- 点击服务器图片列表的「全部」会加载剩余分页并显示进度。使用表头复选框可在加载完成后勾选符合条件的图片。

已为 AutoFlow Desktop 0.2.2-rc.3.20261119.1 准备。待当前任务结束后重启，以加载配套 Host 和 Client。

## Visual Curator 0.2.27

- Scroll near the bottom of the server image list to load the next page. Select all loads the remaining pages and selects incomplete images in the current filter.
- Keep loaded rows and the previous selection if a page fails. Appending pages retains earlier previews and allows interrupted imports to resume.
- Verify images from later pages before uploading approved results. The configured per-batch import limit still applies.

Prepared for AutoFlow Desktop 0.2.2-rc.3.20261118.3. Restart after active tasks finish to load the matching Host and Client.

## Visual Curator 0.2.27 更新说明

- 滚动到服务器图片列表底部附近会自动加载下一页。点击全选会加载剩余分页，再选中当前筛选下尚未完成的图片。
- 分页失败时保留已加载记录和原有选择。追加分页时复用已有预览，中断的导入仍可继续。
- 上传合格成品前会核对后续页面的图片。单批导入继续遵守现有配置的上限。

已为 AutoFlow Desktop 0.2.2-rc.3.20261118.3 准备。待当前任务结束后重启，以加载配套 Host 和 Client。

## Visual Curator 0.2.26

- The crop canvas shows local pause status separately from remote image receipts. Resume uses the saved receipt.
- Retry controls identify the action and its version. A same-image review stays in the review step. The rework line appears when a new image generation has been accepted.
- Style tasks apply their saved style rules when rechecking a complete generated image.
- Older planning holds can continue from an enlarged crop of the original. Source inspection retains the protected subject identities and the saved safe area. Accepted results and history are preserved.

Prepared for AutoFlow Desktop 0.2.2-rc.3.20261118.2. Restart after active tasks finish to load the matching Host and Client.

## Visual Curator 0.2.26 更新说明

- 裁剪画布分别显示本地暂停状态和远端生图回执。恢复沿用已保存的回执。
- 重试按钮标明具体动作和版本。同图复审留在复审节点，实际重新生图后才显示返工线。
- 风格任务复审完整生成图时，按该任务保存的风格规则检查。
- 旧规划可以从原图局部放大复核接着处理。原图复核沿用受保护的主体和已保存的安全区，保留历史任务和已通过结果。

已为 AutoFlow Desktop 0.2.2-rc.3.20261118.2 准备。待当前任务结束后重启，以加载配套 Host 和 Client。

## Visual Curator 0.2.25

- Continue image storage migration when referenced historical files are already missing; retain those records and report the missing-file count.
- Verify every available file before switching directories. New source-file loss or checksum mismatches still stop migration.
- Prioritize migration status, destination, progress and resume actions in the storage dialog, with shorter guidance and expandable quota settings.

Prepared for AutoFlow Desktop 0.2.2-rc.3.20261117.2; publication is pending. Restart after active tasks finish to load the matching Host and Client.

## Visual Curator 0.2.25 更新说明

- 历史引用文件已缺失时，仍可迁移现有图片，保留相关记录并显示缺失文件数量。
- 所有现有文件校验通过后才切换目录；迁移中新丢失的源文件或校验不一致仍会阻止切换。
- 存储弹窗优先显示迁移状态、目标目录、进度和继续迁移操作，精简说明并折叠额度设置。

已为 AutoFlow Desktop 0.2.2-rc.3.20261117.2 准备，尚待发布；待当前任务结束后重启，以加载配套 Host 和 Client。

## Visual Curator 0.2.24

- Keep every visible car part inside the safe area, including peripheral parts; require at least 97% containment for other main subjects and full containment for critical structures. Natural background variation remains allowed.
- Use complete generated canvases without pasting source images onto them; recover saved reviews and image receipts without repeating generation.
- Keep planning and final-review geometry consistent, with one bounded automatic correction for confirmed defects. Saved practical-v1 tasks keep their policy until explicit current-policy adoption.
- Prepare references from archived high-resolution originals or validated image data without repeating upload admission or reducing source quality.
- Move image storage to a selected directory while retaining originals, saved outputs and task history. Subscription results can use ESPCN; the API key route skips neural upscaling.

Prepared for AutoFlow Desktop 0.2.2-rc.3.20261117.1; publication is pending. Restart after active tasks finish to load the matching Host and Client.

## Visual Curator 0.2.24 更新说明

- 汽车所有可见部分完整位于安全区，包括外围部件；其他主要主体至少 97% 位于安全区，关键结构须完全位于安全区，同时允许自然背景变化。
- 使用完整生成画布，禁止回贴原图；恢复已保存的复审和生图回执，避免重复生成。
- 统一规划与最终复审的安全区计算，明确成品缺陷最多自动纠正一次；已保存的 practical-v1 任务保留原策略，显式采用当前策略才升级。
- 准备高分辨率参考图时复用归档原件或已验证图片数据，不重复上传受理检查，也不降低原图质量。
- 图片存储可迁移到所选目录，保留原图、成品与任务历史；订阅通道可使用 ESPCN，API Key 通道跳过神经超分。

已为 AutoFlow Desktop 0.2.2-rc.3.20261117.1 准备，尚待发布；待当前任务结束后重启，以加载配套 Host 和 Client。

## Visual Curator 0.2.23

- Preview image storage usage and unreferenced files, then confirm cleanup explicitly. Saved originals, outputs and hidden history remain protected; active image tasks block cleanup.
- Increase the storage allowance without removing saved images. The redesigned dialog groups usage, reclaimable space and the limit form, with light, dark and narrow-screen layouts.
- Remember each image provider's account and model within the current profile.
- Support rc.2 and rc.3 Hosts while retaining existing settings and task history.

Included with AutoFlow Desktop 0.2.2-rc.3.20261116.1. Restart after active tasks finish to load the matching Host and Client.

## Visual Curator 0.2.23 更新说明

- 先预览图片存储占用与未引用文件，再二次确认清理；保留已保存原图、成品及隐藏历史，图片任务执行期间禁止清理。
- 支持调高存储上限，已有图片保持不变；新版弹窗按占用、可释放空间和额度表单分区，适配亮暗主题与窄屏。
- 按当前 profile 记住各生图来源的账号和模型。
- 支持 rc.2、rc.3 宿主，保留现有设置和任务历史。

随 AutoFlow Desktop 0.2.2-rc.3.20261116.1 提供；待当前任务结束后重启，以加载配套 Host 和 Client。

## Visual Curator 0.2.22

Local, gallery and server imports confirm the selected account and model before admission. The dialog closes on submission; progress, errors and retry actions stay in the batch table. Only the latest approved and confirmed uploaded output is complete; incomplete originals can be selected again with history retained. Approved results upload together after their batch finishes. Selected image catalogs preload without waiting for unrelated providers.

Included with AutoFlow Desktop 0.2.2-rc.1.20261115.3. Restart after active tasks finish to load the matching Host and Client; existing configuration and history are retained.

## Visual Curator 0.2.22 更新说明

本地、收藏夹和服务器原图统一确认账号与模型。提交后关闭弹窗，导入进度、错误与重试直接显示在批次表格。仅最新成品合格且确认上传后标记完成，其余原图可重新选择并保留历史；批次结束后合并上传合格成品。当前生图目录提前加载，不等待未选中的来源。

随 AutoFlow Desktop 0.2.2-rc.1.20261115.3 提供；任务结束后重启以加载配套 Host 和 Client，保留现有配置和历史。

## Visual Curator 0.2.21

- Preserve generated candidates during review recovery and reject contradictory skip decisions.
- Keep final image quality checks, protected subject evidence and per-version history visible.
- Add edge pixel rulers, measurements, pointer crosshairs and resizable history navigation.
- Group image workspaces and inspection results, with saved prompts in a read-only tabbed editor.

## Visual Curator 0.2.21 更新说明

- 复审故障恢复保留生成候选，拒绝矛盾的跳过决策。
- 保留最终图质量检查、主体保护证据和逐版本历史。
- 大图新增边缘像素标尺、尺寸与鼠标十字线，历史版本栏可拖拽调宽。
- 图片工作区与检查信息分区展示，已保存提示词通过独立只读编辑器查看。

## Visual Curator 0.2.20

- Settings tabs, forms and the footer align with the gallery's left edge while retaining readable form widths.
- Reviews retain the planned subject roles. Supporting props outside the inner safe area are nonblocking; automatic rework requires a confirmed failure. Uncertain evidence keeps the saved image pending review.
- Image history compares saved versions with the original and shows estimated safety overflow. History images and full-size previews support saving the complete resource.
- New crop batches can select a Codex image account or a configured OpenAI API key and image model. Official-key results use their reviewed native resolution; Codex results use ESPCN x3 after review.

This is an independent plugin update; reinstalling Desktop is unnecessary. Update after active tasks finish, then restart AutoFlow to load the matching Host, Client and profile patch. Existing settings, accounts, task data and saved results are retained; saved tasks keep their frozen prompts and roles.

## Visual Curator 0.2.20 更新说明

- 设置页签、表单和底部操作区与图库共用左侧对齐线，保留适合阅读的表单宽度。
- 复审沿用规划中的主体角色，陪衬越过内侧安全区只作提示；自动返工仅针对明确不合格项，证据不确定时保留已保存图片等待复核。
- 图片历史支持按版本对比原图与成品，并显示模型估计的安全区越界原因；历史图片与大图预览支持保存完整资源。
- 新裁剪批次可选择 Codex 生图账号或已配置的 OpenAI API Key 与模型；官方 Key 成品使用已复审的原生分辨率，Codex 成品通过复审后才使用 ESPCN x3 超分。

本次为独立插件更新，无需重新安装桌面包。当前任务结束后更新插件并重启 AutoFlow，以加载配套的 Host、Client 和 profile patch。现有设置、账号、任务数据及已保存结果保留，历史任务继续使用冻结的提示词与角色。

## Visual Curator 0.2.17

Select a Codex image account or a configured OpenAI API key and image model for each new crop batch. Official-key images use the reviewed native result, while Codex images use ESPCN x3 only after review. Complete cosmetic products whose original crop edge falls inside the wallpaper.

Included with AutoFlow Desktop 0.2.2-rc.1.20261113.2. Existing settings, accounts, task data and saved results are retained.

## Visual Curator 0.2.17 更新说明

新裁剪批次可选择 Codex 生图账号，或已配置的 OpenAI API Key 和模型。官方 Key 使用复审通过的原生图；Codex 图复审通过后才进行 ESPCN x3 超分。修复原图裁切边进入壁纸内部时彩妆物体被平切的问题。

随 AutoFlow Desktop 0.2.2-rc.1.20261113.2 提供，保留现有设置、账号、任务数据和已保存结果。

## Visual Curator 0.2.16

Wallpaper planning now identifies primary subjects, indispensable parts and supporting objects separately. Retries retain those identities and candidate placement, keeping focal objects inside the safe area while preserving supporting products and natural frame edges. Native-image review must pass before ESPCN x3 reconstruction.

Included with AutoFlow Desktop 0.2.2-rc.1.20261113.1. Update after active tasks finish and restart AutoFlow. Existing settings, accounts, reference data and saved results are retained.

## Visual Curator 0.2.16 更新说明

壁纸规划逐件区分视觉主角、必要结构与陪衬；重试保留实体身份和候选摆放，让主角进入安全区，同时保留陪衬商品及画框边缘的自然完整性。原生生成图通过复审后才使用 ESPCN x3 超分。

随 AutoFlow Desktop 0.2.2-rc.1.20261113.1 一同提供。请在当前任务结束后更新并重启；保留现有设置、账号、参考数据和已保存结果。
