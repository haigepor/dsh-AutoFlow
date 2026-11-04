## Visual Curator 0.2.7

- Saved reference observations, automatic style profiles and reference datasets are independent of the selected execution model. Switching models preserves analyzed status, original request records and existing dataset bytes.
- New searches and crops use the selected vision model. Paused tasks retain their accepted model and budgets after restart. Incremental analysis reuses valid observations across models; full reanalysis still requires explicit confirmation.
- Analyze all references, positive examples only or counterexamples only, with distinct instructions for each role. Other roles retain valid observations; incomplete evidence never becomes a completed full style package.
- Once references are complete, the model consolidates the style and matching prompt and automatically saves a checksummed dataset. Failed package commits resume without repeating model calls. The latest complete dataset stays first.
- Start a search from a previously completed full dataset while new analysis runs or is paused. Each search freezes the selected dataset's rules and references.
- Changed references, rules, judgments or image processing still require reanalysis. The reference badge now distinguishes this from a plugin version update.

Update the plugin and restart after current tasks finish. No data migration or desktop installer is required. Human-published releases and controlled comparisons retain their reviewer qualification checks. Automatic installation remains opt-in. Keyless checks do not validate live image-source login or paid model output.

## 视觉策展 0.2.7

- 已保存的参考观察、自动风格画像和参考数据集独立于执行模型。切换模型会保留已分析状态、原始请求记录和已有数据集文件。
- 新找图和裁剪任务使用所选视觉模型，暂停任务重启后仍沿用原模型和预算。增量分析跨模型复用有效观察，全部重新分析仍须明确确认。
- 支持全部参考、仅正例和仅反例分析，并采用不同角色的提示词。其他角色保留有效观察，待依据齐全后生成完整风格包。
- 参考图分析齐全后，模型统一整理风格与匹配提示词，自动保存带校验和的数据集并置顶。封装提交失败可继续任务，不重复调用模型。
- 新分析进行或暂停时，也可选择历史完整数据集找图；每个找图任务固定所选版本的规则和参考图。
- 引用、规则、判断或图片处理方式改变时，仍须重新分析。参考图标记改为“需重新分析”，避免与插件版本更新混淆。

在当前任务结束后更新插件并重启，无需迁移数据或重装桌面安装包。人工发布版本和受控对比保留评估模型资格检查，自动安装仍须明确开启。无密钥检查不代表真实图库登录或付费模型输出已经验收。
