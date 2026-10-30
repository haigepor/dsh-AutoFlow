/** Prompt compilation uses only explicitly selected transferable rules and the new brief. */
import { generationSchema, StylePromptError, type StyleAnalysis, type GenerationInput, type PromptGeneration, type Reference } from './model.ts'

/** @param analysis Validated observations. @param input User choices. @returns Transferable rules in user-selected order. */
export function selectedRules(analysis: StyleAnalysis, input: GenerationInput) {
  const rules = input.selectedRuleIds.map(id => analysis.rules.find(rule => rule.id === id))
  if (rules.some(rule => !rule || rule.scope === 'scene' || rule.status === 'unknown')) throw new StylePromptError('invalid-input')
  return rules.filter((rule): rule is StyleAnalysis['rules'][number] => rule !== undefined)
}

/** Compose without another model request or any implicit source-scene inheritance.
 * @param analysis Saved style. @param input New content and selected rules. @returns One deterministic bilingual draft.
 */
export function compileQuick(analysis: StyleAnalysis, input: GenerationInput): PromptGeneration {
  if (!input.brief.en || !input.changes.en) throw new StylePromptError('invalid-input')
  const rules = selectedRules(analysis, input)
  const style = { zh: rules.map(rule => rule.description.zh).join('；'), en: rules.map(rule => rule.description.en).join('; ') }
  const fullPrompt = { zh: `${input.brief.zh}。${input.changes.zh}。${style.zh}。参考图仅用于以上选定风格属性，新画面内容以本提示词为准。`, en: `${input.brief.en}. ${input.changes.en}. ${style.en}. Use the reference only for these selected style attributes; use this prompt for the new scene content.` }
  return { stylePrompt: { zh: `【新主体或场景】。${style.zh}。`, en: `[NEW SUBJECT OR SCENE]. ${style.en}.` }, fullPrompt, usedRuleIds: rules.map(rule => rule.id),
    variants: [{ title: { zh: '新画面草稿', en: 'New scene draft' }, prompt: fullPrompt, changes: [input.changes] }], newCreativeChoices: [],
    notes: [{ zh: '请手动上传参考图；本草稿未经过实际生图验证。', en: 'Upload the reference image manually. This draft has not been validated by generating images.' }] }
}

/** Reject mismatched rule coverage and duplicate or incomplete model variants.
 * @param raw Model JSON. @param analysis Saved observations. @param input User choices. @param count Required variant count.
 * @returns Validated bilingual result.
 */
export function validateGeneration(raw: unknown, analysis: StyleAnalysis, input: GenerationInput, count: number): PromptGeneration {
  const result = generationSchema.parse(raw), expected = selectedRules(analysis, input).map(rule => rule.id)
  if (result.usedRuleIds.length !== expected.length || new Set(result.usedRuleIds).size !== expected.length || expected.some(id => !result.usedRuleIds.includes(id))
    || result.variants.length !== count || new Set(result.variants.map(item => item.prompt.zh.trim().toLowerCase())).size !== count || new Set(result.variants.map(item => item.prompt.en.trim().toLowerCase())).size !== count) throw new StylePromptError('invalid-output')
  return result
}

/** Export semantic reference roles, never invented backend request parameters or inline images.
 * @param value Saved analysis, user selections, settled result and references. @returns Portable JSON fields and a Markdown companion.
 */
export function exportBundle(value: { analysis: StyleAnalysis; input: GenerationInput; result: PromptGeneration; references: Reference[] }) {
  const rules = selectedRules(value.analysis, value.input)
  const referencePlan = { formatVersion: 1, exportType: 'reference-usage-plan', target: value.input.platform, requiresManualUpload: true,
    instructions: { zh: '在生图平台手动上传对应参考图；仅参考选定的视觉属性，主体和布局以配套新提示词为准。', en: 'Manually upload the corresponding references. Use only the selected visual attributes; follow the new prompt for subjects and layout.' },
    references: value.references.map(ref => ({ id: ref.id, fileName: ref.name, sha256: ref.sha256, width: ref.attachment.width, height: ref.attachment.height, role: 'style-reference', preserveRuleIds: rules.filter(rule => rule.referenceIds.includes(ref.id)).map(rule => rule.id), inheritSourceContent: false })),
    selectedRules: rules, newContent: value.input.brief, changePlan: value.input.changes,
  }
  const json = { formatVersion: 1, name: value.analysis.name, summary: value.analysis.summary, referencePlan, prompts: value.result }
  const markdown = [`# ${value.analysis.name}`, '', value.analysis.summary, '', '## 中文提示词', '', value.result.fullPrompt.zh, '', '## English prompt', '', value.result.fullPrompt.en, '',
    ...value.result.variants.flatMap(item => [`## ${item.title.zh} / ${item.title.en}`, '', item.prompt.zh, '', item.prompt.en, '', ...item.changes.map(change => `- ${change.zh} / ${change.en}`), '']),
    '## 参考图 / References', '', ...referencePlan.references.map(ref => `- ${ref.fileName} (${ref.id}, SHA-256: ${ref.sha256})`), '', referencePlan.instructions.zh, '', referencePlan.instructions.en, '',
    '## 保留的风格 / Selected style', '', ...rules.map(rule => `- ${rule.description.zh} / ${rule.description.en}`), '', ...value.result.notes.map(note => `${note.zh}\n\n${note.en}`), '',
  ].join('\n')
  return { ...json, markdown }
}
