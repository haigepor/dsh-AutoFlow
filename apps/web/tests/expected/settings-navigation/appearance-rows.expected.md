{
  "layout": "flex",
  "padding": "16px 0px",
  "height": 93,
  "controlHeight": 60,
  "titleFont": "14px",
  "titleWeight": "400"
}

- heading "主题" [level=1]
- button "重置外观"
- region "外观模式":
  - heading "外观模式" [level=2]
  - paragraph: 选择浅色、深色，或跟随系统。
  - group "外观模式":
    - button "跟随系统" [pressed]
    - button "浅色"
    - button "深色"
- region "主题颜色预设":
  - heading "主题颜色预设" [level=2]
  - paragraph: 选择界面的基础配色与强调色。
  - group "主题颜色预设":
    - button "蓝灰" [pressed]
    - button "鸢尾紫"
- region "字体":
  - heading "字体" [level=2]
  - paragraph: 影响界面正文；代码字体保持原样。
  - button "字体": 系统默认
- region "圆角":
  - heading "圆角" [level=2]
  - paragraph: 调整卡片、按钮等控件的圆角。
  - button "圆角": 0.75 rem
- region "菜单动效速度":
  - heading "菜单动效速度" [level=2]
  - paragraph: 调整菜单选项高亮移动的速度。
  - button "菜单动效速度": 标准（{{duration}}）
