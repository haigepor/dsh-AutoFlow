# 桌面更新说明

[English](README.md) | 中文

桌面更新弹窗、官方更新清单和 GitHub Release 使用同一份经过审阅的版本说明。说明面向用户可见的行为，也包含桌面随附插件的变更；实现日志、测试数量和未经证实的提速承诺不进入产品文案。

## 日常积累

实施桌面可见变更时，在 `changes/` 增加一个 UTF-8 JSON 文件。使用稳定的 `id`，分类为 `features`、`improvements`、`fixes` 或 `other`，填写简明的 `text.en` 和 `text.zh-CN`。交代触发条件和结果；同一问题多次修复在发布前合并。只记录已完成且用户可感知的工作。发布后保留原条目，版本清单记录已经收录的 ID。

```json
{
  "id": "plugin-download-idle-timeout",
  "category": "fixes",
  "text": {
    "en": "Plugin downloads can continue while data is arriving instead of timing out after a fixed total duration.",
    "zh-CN": "修复插件安装包持续下载时仍因固定总时限而超时的问题。"
  }
}
```

## 整理版本

确定精确构建版本后，从仓库根目录运行：

```sh
node --import tsx/esm apps/desktop/scripts/release-notes.ts <exact-build-version>
```

命令收集此前版本清单尚未收录的 ID，以独占创建方式写入 `releases/<版本>.json`。原条目保留；空版本、重复 ID、缺少翻译、占位文案和已存在的版本文件均被拒绝。审阅措辞和范围，合并相关条目，移除内部工作和未完成功能，在打包前将清单与源码一并提交。已经发布的版本说明不得覆盖；纠正内容使用新版本和新条目 ID。需要在后续稳定版再次强调某项变更时，在审阅该版本清单时加入，不重复创建日常条目。

## 发布与展示

发布通过 `git show <构建提交>:apps/desktop/release-notes/releases/<版本>.json` 读取说明。未提交的说明或较新工作区的说明不能描述旧构建。说明缺失、无效或版本不符时，在上传前拒绝准备发布。结构化 `dshReleaseNotes`、标准 `releaseNotes` 和双语 Release 正文均由这些条目生成；官方元数据仍位于配置的官方清单地址。

弹窗在下载控制下方用四类纯文本条目展示说明，省略空分类，长内容独立滚动。中文界面使用中文内容，其他界面语言使用英文内容，标题和控件跟随当前语言。下载进度更新保留说明滚动位置。旧清单显示本地化的说明缺失提示；可选说明无效不会阻止下载已校验的安装包。下载完成后安装仍需单独确认。
