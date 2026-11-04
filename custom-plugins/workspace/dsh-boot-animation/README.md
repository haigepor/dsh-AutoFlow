# AutoFlow boot animation

English | [中文](README.zh.md)

The package supports AutoFlow hosts based on DSH `0.2.2-alpha.2` and `0.2.2-rc.1`, using AutoFlow's startup integration. Older desktop builds require a manual restart after plugin installation; the matching new desktop waits for current work before applying installed updates automatically.

This source adaptation of [NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation) keeps the upstream BSD-3-Clause license and Host media library. AutoFlow uses **DeepSeek cyberpunk intro** (`builtin:cyberpunk`) for application startup. Only `assets/cyberpunk.mp4` is retained; the generated embedded module also contains only this clip. The upstream conversation replay and picker UI are outside this startup integration.

The MP4 was restored without re-encoding from the upstream embedded bytes. The build verifies its SHA-256 against `src/clip.json` and generates the compact Host media module from it. Vite packages the original 1280×720 video with the Web application; `object-fit: contain` preserves its full frame. Base64 changes storage encoding rather than resolution. The renderer never imports or parses the embedded clip module. The early overlay runs alongside Host startup, client plugin activation, renderer mounting, and Session/Workspace baseline delivery. It leaves after the video ends and both lists report `phase: ready`, including genuinely empty lists. The plugin owns the `data-dsh-startup-state` marker; the application bootstrap owns the overlay and mounted signal.

Skip, Escape, reduced motion, playback failure, a data error, and a 30-second watchdog keep the application accessible. Failures in the existing boot path dismiss the overlay and retain the original diagnostics. A slow startup keeps the final video frame with a loading indicator; the timeout exposes the underlying application instead of claiming initialization succeeded. Tool panels, archived history, and other on-demand data keep their existing lazy loading.

`pnpm run build:boot-animation` builds the plugin and validates its asset. Web and Desktop select it in new profiles and preserve existing bundle choices. **Plugins → Startup animation** shows its artwork, feature switch, and introduction behind the title's information button. The active Host plugin reads the current effective profile before injecting `__DSH_STARTUP_ANIMATION__`, including while HMR is still applying a disable action. Desktop reads that profile before serving its local entry, so enabled profiles can play before Host startup. Without explicit enablement, the application creates no video and requests no MP4. Disabling the bundle or its `dsh-boot-animation` row therefore prevents playback on the next document, including after restart. Its media routes remain under `/dsh-boot-animation/`.

The five custom plugins share 512×512 transparent hand-painted artwork. This package's `assets/plugin-logo-v2.webp` is the film-projector logo; `assets/plugin-logo-v2.prompt.txt` records its generation prompt.

The Plugins page can check this bundle's independent GitHub releases. Automatic installation is opt-in; restart loads the updated plugin. The early application startup presentation and packaged video also require a matching Desktop/Web build when those assets change. See the [release guide](release/README.md).
