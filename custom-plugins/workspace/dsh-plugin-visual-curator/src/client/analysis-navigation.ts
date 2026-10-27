/** Transcript navigation preserves individual request attempts and retained ordering. */
import type { AnalysisMessage } from '../shared/analysis-process.ts'

/** One clickable response; repeated batch numbers remain separate request attempts. */
export interface AnalysisNavigationEntry {
  sequence: number
  kind: AnalysisMessage['kind']
  batch?: number
  imageCount: number
  attempt: number
  attempts: number
  state: AnalysisMessage['state']
}

/** @param messages Retained model responses in display order. @returns Distinct targets with attempt counts derived only from the retained transcript. */
export function analysisNavigation(messages: readonly AnalysisMessage[]): AnalysisNavigationEntry[] {
  const key = (message: AnalysisMessage) => message.kind === 'summary' ? 'summary' : `batch:${message.batch ?? message.sequence}`
  const totals = new Map<string, number>(), seen = new Map<string, number>()
  for (const message of messages) totals.set(key(message), (totals.get(key(message)) ?? 0) + 1)
  return messages.map(message => {
    const group = key(message), attempt = (seen.get(group) ?? 0) + 1
    seen.set(group, attempt)
    return { sequence: message.sequence, kind: message.kind, ...(message.batch === undefined ? {} : { batch: message.batch }), imageCount: message.imageIds.length, attempt, attempts: totals.get(group)!, state: message.state }
  })
}
