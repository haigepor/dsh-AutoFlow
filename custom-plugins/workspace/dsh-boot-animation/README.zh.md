# AutoFlow 启动动画

[English](README.md) | 中文

本目录基于 [NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation) 做源码适配，保留上游 BSD-3-Clause 许可和 Host 片库。AutoFlow 默认使用「DeepSeek 赛博朋克片头」（`builtin:cyberpunk`）作为应用开屏。素材目录仅保留 `assets/cyberpunk.mp4`，生成的内嵌模块也仅包含这一段。原插件的会话重播和片库界面不属于此次启动集成。

MP4 从上游内嵌字节无损还原，没有重新编码。构建根据 `src/clip.json` 校验其 SHA-256，再生成精简的 Host 媒体模块。Vite 随 Web 应用打包原始 1280×720 视频，使用 `object-fit: contain` 完整显示画面。Base64 只改变存储编码，不改变分辨率。渲染进程不导入或解析内嵌片库。开屏与 Host 启动、客户端插件激活、界面挂载及会话和工作区首批数据加载并行。视频结束且两个列表都报告 `phase: ready` 后退场，真实空列表也算就绪。插件拥有 `data-dsh-startup-state` 标记，应用启动入口拥有覆盖层和界面挂载信号。

跳过、Escape、减少动态效果、播放失败、数据错误及 30 秒看门狗保证应用入口可达。原启动流程失败时立即撤掉动画并保留原有诊断。加载较慢时保留视频末帧和加载指示；超时显示下层应用，不宣称初始化成功。工具面板、归档历史和其他按需数据继续延迟加载。

`pnpm run build:boot-animation` 构建插件并校验素材。Web 和 Desktop 在新 profile 中默认选择该 bundle，已有 bundle 选择保持原样。**插件 → 启动动画**显示图标、功能开关，以及点击标题旁信息按钮打开的介绍。启用的 Host 插件在注入 `__DSH_STARTUP_ANIMATION__` 前读取当前生效的 profile，覆盖 HMR 尚未完成禁用的情况。Desktop 在提供本地入口前读取该 profile，使已启用的配置仍可在 Host 启动前播放。缺少明确启用状态时，应用不创建视频，也不请求 MP4。因此关闭 bundle 或其 `dsh-boot-animation` 行后，下一份文档及重启后均不播放。片库媒体路由保留在 `/dsh-boot-animation/`。

五个自定义插件统一使用 512×512 透明背景的手绘插画。本插件的 `assets/plugin-logo-v2.webp` 是放映机图标，`assets/plugin-logo-v2.prompt.txt` 保存其生成提示词。

插件页可以检查此组合包的独立 GitHub 版本。自动安装需明确开启，重启后加载更新。应用早期启动界面或随包视频变化时，还需要配套 Desktop/Web 构建。详见[发布指南](release/README.zh.md)。
