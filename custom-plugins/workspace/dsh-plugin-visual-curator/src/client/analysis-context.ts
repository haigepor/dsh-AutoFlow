/** Per-request context occupancy, separate from the task's cumulative model usage. */
import type { AnalysisRequest } from '../shared/analysis-process.ts'

/** Missing fields remain unavailable until the corresponding native facts are recorded. */
export interface AnalysisContextUsage {
  usedTokens?: number
  contextWindow?: number
  percent?: number
  retained?: true
}

/**
 * Read the last reported analysis or summary occupancy while newer usage is pending.
 * @param requests Ordered saved task attempts, including auxiliary compaction calls.
 * @returns Disjoint input and output usage with a bounded ring percentage when capacity is known.
 */
export function analysisContextUsage(requests: readonly AnalysisRequest[]): AnalysisContextUsage {
  // 压缩调用可能使用另一模型；不能将其容量与分析请求的用量混算。
  const analyses = requests.filter(request => request.operation !== null), latest = analyses.at(-1)
  // 新请求尚未报告用量时保留上一请求的完整事实，不把旧用量与新模型容量混算。
  const measured = latest?.native?.usage ? latest : analyses.findLast(request => request.native?.usage)
  const native = (measured ?? latest)?.native
  const contextWindow = native?.context?.contextWindow, usage = native?.usage
  const usedTokens = usage === undefined ? undefined : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
  return {
    ...(measured && measured !== latest ? { retained: true as const } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(usedTokens === undefined ? {} : { usedTokens }),
    ...(contextWindow === undefined || usedTokens === undefined ? {} : { percent: Math.min(100, usedTokens / contextWindow * 100) }),
  }
}
