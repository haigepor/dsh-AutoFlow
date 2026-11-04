## Visual Curator 0.2.6

- New image searches refresh readable mismatch history at Run admission, including results saved after conversation or task preparation. Confirmed rejected photos are skipped before another review when task, rules and review recipe match.
- Stopping a conversation cancels its visual tasks and pending admissions. Closing a dialog and natural turn completion keep background work active; other Sessions and independent workbench tasks remain active.
- Saved results, styles, references, credentials and feature choices remain. Restart after current tasks finish; no data migration is required. Automatic installation is opt-in.

Preventing cancelled-job notices from waking an idle conversation requires the matching AutoFlow host update. This plugin release does not replace the desktop host. Keyless checks do not validate live image-source login or paid model output.

## 视觉策展 0.2.6

- 新找图任务在实际受理时重新读取有权访问的不匹配历史，包含会话或任务准备后保存的结果。需求、规则和复核配方相同时，已确认拒绝的照片在再次复核前跳过。
- 停止会话会同步取消其视觉任务和正在受理的工作。关闭弹窗或对话自然结束时后台任务继续运行，其他会话与工作台独立任务保持运行。
- 已保存结果、风格、引用、凭据和功能选择保留。在当前任务结束后更新并重启，无需迁移数据；自动安装需明确开启。

阻止取消通知自动唤醒空闲会话需要配套 AutoFlow 宿主更新，本次插件发布不替换桌面宿主。无密钥检查不代表真实图库登录或付费模型输出已经验收。
