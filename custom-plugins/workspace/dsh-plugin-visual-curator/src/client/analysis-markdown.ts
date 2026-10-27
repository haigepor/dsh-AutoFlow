/** Saved analysis fields projected to readable native Chat Markdown; original provider text stays available. */
import type { AnalysisDetail, AnalysisMessage } from '../shared/analysis-process.ts'
import { styleSummarySchema } from '../shared/style-analysis.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { parseModelJson } from '../shared/model-json.ts'
import { parse as parsePartialJson, Allow } from 'partial-json'
import { z } from 'zod'
import { dimensionSchema } from '../shared/model.ts'

const dimensions = ['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth'] as const
const label = (t: WorkbenchText, field: string) => {
  const dimension = dimensions.find(value => value === field)
  return dimension ? t(dimension) : field
}
// 名称和结构化字段是数据，不能把其中的 Markdown 标记解释成额外段落或链接。
const literal = (text: string) => text.replace(/([\\`*_[\]{}<>#+.!|~-])/gu, '\\$1').replace(/\r?\n/gu, ' ')
const valueText = (value: unknown) => literal(typeof value === 'string' ? value : JSON.stringify(value) ?? '')

const partialResponse = z.object({ observations: z.array(z.unknown()).optional(), name: z.string().optional(), summary: z.string().optional(), matchingPrompt: z.string().optional() })
const partialObservation = z.object({ imageVersionId: z.string(), dimensions: z.array(z.unknown()).optional() })
const partialDimension = z.object({ dimension: dimensionSchema, observation: z.string(), uncertain: z.boolean().optional() })

// 只投影已收到的文字，不补写缺失字段，不参与 Host 的严格校验、计数或检查点提交。
function streamingMarkdown(message: AnalysisMessage, detail: AnalysisDetail, t: WorkbenchText): string {
  let raw: unknown
  try { raw = parsePartialJson(message.content.trimStart().replace(/^`{3,}(?:json)?[\t ]*\r?\n/u, ''), Allow.STR | Allow.ARR | Allow.OBJ) }
  catch (error) { return '' }
  const parsed = partialResponse.safeParse(raw)
  if (!parsed.success) return ''
  if (message.kind === 'summary') return [parsed.data.name ? `## ${literal(parsed.data.name)}` : '', parsed.data.summary ? valueText(parsed.data.summary) : '', parsed.data.matchingPrompt ? `### ${t('matchingPrompt')}\n\n${valueText(parsed.data.matchingPrompt)}` : ''].filter(Boolean).join('\n\n')
  return (parsed.data.observations ?? []).flatMap(value => {
    const row = partialObservation.safeParse(value)
    if (!row.success || !message.imageIds.includes(row.data.imageVersionId)) return []
    const fields = (row.data.dimensions ?? []).flatMap(value => {
      const field = partialDimension.safeParse(value)
      return field.success && field.data.observation ? [`- **${t(field.data.dimension)}**：${valueText(field.data.observation)}${field.data.uncertain ? `（${t('uncertain')}）` : ''}`] : []
    })
    if (!fields.length) return []
    const name = detail.images.find(image => image.imageVersionId === row.data.imageVersionId)?.name ?? row.data.imageVersionId
    return [[`### ${t('chatImage')} ${String(message.imageIds.indexOf(row.data.imageVersionId) + 1).padStart(2, '0')} · ${literal(name)}`, ...fields].join('\n\n')]
  }).join('\n\n---\n\n')
}

/** @param text Exact provider output, including truncated JSON. @returns Safe native code block for structured output, or unchanged prose. */
export function providerMarkdown(text: string): string {
  if (!/^\s*[[{]/u.test(text)) return text
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/gu)].map(match => match[0].length + 1)))
  return `${fence}json\n${text}\n${fence}`
}

/** @param rows Saved observations only. @param detail Authorized task detail. @param t Locale. @param imageIds Original batch ordering. @returns Native Markdown without fabricated model output. */
export function observationsMarkdown(rows: AnalysisDetail['observations'], detail: AnalysisDetail, t: WorkbenchText, imageIds?: readonly string[]): string {
  return rows.map((row, index) => {
    const position = imageIds?.indexOf(row.imageVersionId) ?? index
    const number = String((position < 0 ? index : position) + 1).padStart(2, '0')
    const name = detail.images.find(image => image.imageVersionId === row.imageVersionId)?.name ?? row.imageVersionId
    return [`### ${t('chatImage')} ${number} · ${literal(name)}`, ...row.dimensions.map(dimension => `- **${label(t, dimension.field)}**：${valueText(dimension.value)}${dimension.uncertain ? `（${t('uncertain')}）` : ''}`)].join('\n\n')
  }).join('\n\n---\n\n')
}

/** @param message Saved model response. @param detail Saved task result. @param t Locale. @returns Committed readable content and linked evidence IDs, or the exact provider text as native Markdown. */
export function analysisAnswer(message: AnalysisMessage, detail: AnalysisDetail, t: WorkbenchText): { text: string; structured: boolean; evidence: string[] } {
  if (message.state === 'streaming') return { text: streamingMarkdown(message, detail, t), structured: false, evidence: [] }
  const rows = message.kind === 'analysis' && message.state === 'complete' ? detail.observations.filter(row => message.imageIds.includes(row.imageVersionId)) : []
  if (rows.length) return { text: observationsMarkdown(rows, detail, t, message.imageIds), structured: true, evidence: [] }
  let summary: AnalysisDetail['summary']
  if (message.kind === 'summary' && message.state === 'complete' && message.content) {
    let value: unknown
    try { value = parseModelJson(message.content) } catch (error) { /* 截断或非 JSON 响应仍显示原文，不能作为已保存归纳。 */ }
    const parsed = styleSummarySchema.safeParse(value)
    if (parsed.success) summary = parsed.data
  }
  // 只允许最后一条完整归纳引用当前保存结果，避免把新归纳安到历史消息上。
  const latestSummary = detail.process?.messages?.filter(item => item.kind === 'summary' && item.state === 'complete').at(-1)
  if (!summary && latestSummary?.sequence === message.sequence) summary = detail.summary
  if (!summary) return { text: providerMarkdown(message.content), structured: false, evidence: [] }
  const imageNames = (ids: string[]) => ids.map(id => literal(detail.images.find(image => image.imageVersionId === id)?.name ?? id)).join('、')
  const sections = [`## ${literal(summary.name)}`, valueText(summary.summary), ...summary.dimensions.map(row => [
    `### ${t(row.dimension)}`, valueText(row.description),
    row.consistency !== 'consistent' ? t(row.consistency) : '',
    row.supportImageVersionIds.length ? `**${t('positiveEvidence')}**：${imageNames(row.supportImageVersionIds)}` : '',
    row.counterImageVersionIds.length ? `**${t('negativeEvidence')}**：${imageNames(row.counterImageVersionIds)}` : '',
  ].filter(Boolean).join('\n\n'))]
  if (summary.suggestedRules.length) sections.push(`### ${t('outputSuggestedRules')}`, summary.suggestedRules.map((rule, index) => `${index + 1}. ${valueText(rule.statement)}`).join('\n'))
  sections.push(`### ${t('matchingPrompt')}`, valueText(summary.matchingPrompt))
  return { text: sections.join('\n\n'), structured: true, evidence: [...new Set(summary.dimensions.flatMap(row => [...row.supportImageVersionIds, ...row.counterImageVersionIds]))] }
}
