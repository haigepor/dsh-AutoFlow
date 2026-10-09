# Available

- group:
  - text: 版本更新 已安装 v1.0.0
  - status: 发现新版本 v1.1.0
  - button "检查更新"
  - button "立即更新"
  - text: 自动下载安装
  - paragraph: 自动检查更新；开启后自动安装，重启生效并保留配置
  - switch "自动下载安装" [checked]

# Installing

- group:
  - text: 版本更新 已安装 v1.0.0
  - status:
    - text: 正在下载并安装…
    - progressbar "正在下载并安装…"
  - button "检查更新" [disabled]
  - button "立即更新" [disabled]
  - text: 自动下载安装
  - paragraph: 自动检查更新；开启后自动安装，重启生效并保留配置
  - switch "自动下载安装" [checked] [disabled]

# Restart required

- group:
  - text: 版本更新 已安装 v1.0.0
  - status: 新版本已安装，重启后生效
  - button "检查更新" [disabled]
  - button "重启应用"
  - text: 自动下载安装
  - paragraph: 自动检查更新；开启后自动安装，重启生效并保留配置
  - switch "自动下载安装" [checked]

# Restarting

- dialog "插件已更新，需要重启":
  - heading "插件已更新，需要重启" [level=2]
  - button "关闭"
  - paragraph: 新版本已安装，配置已保留。当前应用继续使用原版本，重启后生效；请先处理正在运行的任务
  - list:
    - listitem: dsh-update-fixture · v1.1.0
  - status:
    - text: 正在重启，等待应用恢复…
    - progressbar "正在重启，等待应用恢复…"
  - button "稍后重启" [disabled]
  - button "正在重启" [disabled]
