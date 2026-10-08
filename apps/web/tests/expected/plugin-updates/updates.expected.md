# Available

- group:
  - text: 版本更新 已安装 v1.0.0
  - status: 发现新版本 v1.1.0
  - button "检查更新"
  - button "立即更新"
  - text: 自动下载安装
  - paragraph: 默认自动检查。开启后自动下载安装新版本，重启生效；保留当前配置。
  - switch "自动下载安装" [checked]

# Restart required

- group:
  - text: 版本更新 已安装 v1.0.0
  - status: 新版本已安装，重启后生效
  - button "检查更新" [disabled]
  - button "重启应用"
  - text: 自动下载安装
  - paragraph: 默认自动检查。开启后自动下载安装新版本，重启生效；保留当前配置。
  - switch "自动下载安装" [checked]
