/** `heroSuggestions` namespace dictionaries — the hero task-card row copy. */

/** Dictionary namespace owned by this plugin. */
export const SUGGESTIONS_NS = 'heroSuggestions'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '开始一项任务',
  'explore': '探索并理解代码',
  'build': '构建新功能、应用或工具',
  'review': '审查代码并提出修改建议',
  'fix': '修复问题和失败',
  'explore.task1': '了解项目结构',
  'explore.prompt1': '请探索当前工作区的代码，解释项目结构、主要入口和模块之间的关系。',
  'explore.task2': '理解一项功能',
  'explore.prompt2': '我想了解一项功能的实现。先问我具体是哪项功能，再沿调用关系解释。',
  'build.task1': '实现一项新功能',
  'build.prompt1': '我想在当前项目中实现一项新功能。先和我确认需求与验收标准，再实施。',
  'build.task2': '构建一个小工具',
  'build.prompt2': '我想构建一个小工具。先问我目标、输入和输出，再结合当前项目提出方案。',
  'review.task1': '评审当前改动',
  'review.prompt1': '请评审当前工作区的未提交改动，优先指出真实缺陷、回归风险和缺少的测试；先不要修改。',
  'review.task2': '检查代码质量',
  'review.prompt2': '请检查当前项目的代码质量，给出有源码依据的改进建议，先评估不改动。',
  'fix.task1': '排查一个问题',
  'fix.prompt1': '我遇到了一个问题。先问我复现步骤、预期和实际表现，再定位根因并修复。',
  'fix.task2': '修复失败的测试',
  'fix.prompt2': '请运行当前项目适用的测试，定位失败根因并做最小修复，保留有效的回归覆盖。',
  'hint.workspace': '请先选择工作区，再选择任务。',
  'hint.draft': '已保留当前草稿和附件；清空输入后可填入任务建议。',
  'hint.busy': '当前输入正在处理中，请稍后再试。',
} satisfies Record<string, string>

/** The heroSuggestions namespace key union. */
export type HeroSuggestionsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Start a task',
  'explore': 'Explore and understand code',
  'build': 'Build features, apps, or tools',
  'review': 'Review code and suggest changes',
  'fix': 'Fix bugs and failures',
  'explore.task1': 'Explain the project structure',
  'explore.prompt1': 'Explore this workspace and explain its structure, main entry points, and module relationships.',
  'explore.task2': 'Understand a feature',
  'explore.prompt2': 'Help me understand a feature. First ask which feature, then explain its implementation and call flow.',
  'build.task1': 'Implement a feature',
  'build.prompt1': 'Help me implement a feature in this project. First clarify requirements and acceptance criteria.',
  'build.task2': 'Build a small tool',
  'build.prompt2': 'Help me build a small tool. First ask about its goal, inputs, and outputs, then propose an approach.',
  'review.task1': 'Review current changes',
  'review.prompt1': 'Review uncommitted changes for bugs, regressions, and missing tests. Do not modify files yet.',
  'review.task2': 'Inspect code quality',
  'review.prompt2': 'Inspect code quality in this project and suggest improvements grounded in the source. Assess only; do not edit.',
  'fix.task1': 'Investigate a bug',
  'fix.prompt1': 'Help me fix a bug. First ask for reproduction steps, expected behavior, and actual behavior.',
  'fix.task2': 'Fix failing tests',
  'fix.prompt2': 'Run the applicable project tests, identify failure causes, and make minimal fixes with meaningful regression coverage.',
  'hint.workspace': 'Choose a workspace first, then select a task.',
  'hint.draft': 'Your draft and attachments are preserved. Clear the input to use a suggestion.',
  'hint.busy': 'The input is busy. Please try again shortly.',
} satisfies Record<HeroSuggestionsKey, string>
