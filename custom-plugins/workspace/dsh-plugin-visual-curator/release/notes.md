## Visual Curator 0.2.12

- Fix plugin loading on older desktop builds whose native picker exposes directory selection only. The package carries its image/reference picker, command runner and Windows dialog worker.
- Declare support for DSH 0.2.2-alpha.2 and 0.2.2-rc.1. Existing tasks, references, datasets and activation choices remain in the profile.

The loading fix works without reinstalling the desktop application; older builds require a manual restart after updating the plugin. The matching new desktop refreshes actual plugin status, shows waiting and restart progress, and applies installed updates automatically after current work finishes. Desktop installer updates still require separate confirmation. Automatic plugin installation remains opt-in.

## 视觉策展 0.2.12

- 修复旧桌面版原生选择器仅提供目录选择时插件无法加载的问题；插件随包提供图片及参考素材选择器、命令执行辅助代码和 Windows 对话框工作进程。
- 明确支持 DSH 0.2.2-alpha.2 和 0.2.2-rc.1。已有任务、参考图、数据集及启用选择继续保存在 profile 中。

加载修复无需重装桌面应用；旧版更新插件后需手动重启。配套新桌面版会刷新真实插件状态、显示等待及重启进度，并在当前工作结束后自动重启使已安装更新生效。桌面安装包更新仍需单独确认。插件自动安装仍需明确开启。
