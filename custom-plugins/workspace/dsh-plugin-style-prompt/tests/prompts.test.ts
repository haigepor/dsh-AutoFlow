/** Reusable style stays separate from scene content throughout prompt compilation and export. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analysisSchema, generationInputSchema, ruleIdSchema, referenceSchema } from '../src/shared/model.ts'
import { compileQuick, exportBundle, validateGeneration } from '../src/shared/compose.ts'
import { analysisInstructions, generationInstructions } from '../src/shared/prompts.ts'

const analysis = () => analysisSchema.parse({
  name: '纸面水彩', summary: '低饱和暖色与松散边缘', medium: 'illustration',
  sourceContent: ['红色雨伞下的猫'], sceneSpecific: ['猫位于画面中央'], unknowns: ['无法确定绘画软件'],
  rules: [
    { id: 'palette', dimension: 'color', description: { zh: '低饱和暖灰与米白色，少量暖色点缀', en: 'Muted warm grey and ivory with restrained warm accents' }, evidence: '大面积暖灰背景与浅色主体', referenceIds: ['ref-1'], scope: 'global', status: 'observed' },
    { id: 'edge', dimension: 'rendering', description: { zh: '保留局部渗化边缘和纸张颗粒', en: 'Preserve locally bleeding edges and visible paper grain' }, evidence: '轮廓局部扩散，纸面纹理可见', referenceIds: ['ref-1'], scope: 'global', status: 'observed' },
    { id: 'layout', dimension: 'composition', description: { zh: '居中对称构图', en: 'Centered symmetrical composition' }, evidence: '主体位于中央', referenceIds: ['ref-1'], scope: 'scene', status: 'inferred' },
  ],
})
const input = () => generationInputSchema.parse({ analysisId: 'analysis-1', selectedRuleIds: ['palette', 'edge'], brief: { zh: '街角咖啡店', en: 'A corner coffee shop' }, changes: { zh: '横向街景，店面偏右，左侧留白', en: 'A horizontal street scene with the shop on the right and open space on the left' }, platform: 'generic', mode: 'quick' })

test('quick compilation carries selected style and new content without inheriting the old subject or layout', () => {
  const result = compileQuick(analysis(), input())
  assert.match(result.fullPrompt.zh, /街角咖啡店/)
  assert.match(result.fullPrompt.en, /corner coffee shop/)
  assert.match(result.stylePrompt.en, /paper grain/)
  assert.doesNotMatch(JSON.stringify(result), /红色雨伞下的猫|猫位于画面中央|居中对称构图/)
  assert.deepEqual(result.usedRuleIds, ['palette', 'edge'])
})

test('structured responses reject duplicate rules and generation cannot select absent or scene-only rules', () => {
  const value = analysis()
  assert.throws(() => analysisSchema.parse({ ...value, rules: [...value.rules, value.rules[0]] }))
  assert.throws(() => compileQuick(value, { ...input(), selectedRuleIds: [ruleIdSchema.parse('missing')] }))
  assert.throws(() => compileQuick(value, { ...input(), selectedRuleIds: [ruleIdSchema.parse('layout')] }))
})

test('export keeps reference roles semantic and omits unsupported provider controls and source content', () => {
  const result = compileQuick(analysis(), input())
  const bundle = exportBundle({ analysis: analysis(), input: input(), result, references: [referenceSchema.parse({ id: 'ref-1', name: 'reference.png', sha256: 'a'.repeat(64), attachment: { attachmentId: 'image-1', mediaType: 'image/png', bytes: 12, width: 10, height: 10 } })] })
  assert.equal(bundle.referencePlan.references[0]?.role, 'style-reference')
  assert.equal(bundle.referencePlan.requiresManualUpload, true)
  assert.doesNotMatch(JSON.stringify(bundle.referencePlan), /negative_prompt|style_strength|reference_weight|红色雨伞/)
  assert.match(bundle.markdown, /corner coffee shop/)
})

test('model generation must use exactly the selected rules and deliver distinct variants', () => {
  const result = compileQuick(analysis(), input())
  assert.throws(() => validateGeneration({ ...result, usedRuleIds: ['layout'] }, analysis(), input(), 1))
  assert.throws(() => validateGeneration({ ...result, variants: [result.variants[0], result.variants[0], result.variants[0]] }, analysis(), input(), 3))
})

test('analysis and synthesis instructions preserve evidence limits and keep image content untrusted', () => {
  assert.match(analysisInstructions, /不确定|unknown/)
  assert.match(analysisInstructions, /不是.*指令/)
  assert.match(generationInstructions, /sourceContent/)
  assert.match(generationInstructions, /不.*整包/)
})

test('normalized attachment metadata retains original dimensions for large-image request projection', () => {
  const reference = referenceSchema.parse({ id: 'ref-1', name: 'large.png', sha256: 'a'.repeat(64), attachment: { attachmentId: 'large-image', mediaType: 'image/png', bytes: 1024, width: 1280, height: 720, originalDimensions: { width: 3840, height: 2160 } } })
  assert.deepEqual(reference.attachment.originalDimensions, { width: 3840, height: 2160 })
})
