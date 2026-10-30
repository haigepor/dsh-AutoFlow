/** One recently viewed analysis, retained only in the owning Client store's memory. */
import type { AnalysisDetail, AnalysisInput, AnalysisTask } from '../shared/analysis-process.ts'

interface CachedAnalysis { detail: AnalysisDetail; inputs: Record<string, AnalysisInput>; fetchedAt: number; taskAtRead: AnalysisTask; stale?: true }

/** @returns A single-entry cache; the owner supplies its configured lifetime and current time. */
export function createAnalysisDetailCache() {
  let saved: CachedAnalysis | undefined
  return {
    /** @param detail Successfully read detail. @param inputs Already authorized saved inputs. @param fetchedAt Read completion time. */
    save(detail: AnalysisDetail, inputs: Record<string, AnalysisInput>, fetchedAt: number): void { saved = { detail, inputs, fetchedAt, taskAtRead: detail.task } },
    /** @param detail Latest visible progress. @param inputs Read inputs. Retains the original read time. */
    update(detail: AnalysisDetail, inputs: Record<string, AnalysisInput>): void {
      if (saved?.detail.task.runId === detail.task.runId) saved = { ...saved, detail, inputs }
    },
    /** @param runId Failed read target. Retain its last good view but require a new successful read. */
    markStale(runId: string): void { if (saved?.detail.task.runId === runId) saved = { ...saved, stale: true } },
    /** @param runId Requested task. @param ttlMs Configured lifetime; zero disables reuse. @param now Current time. @param task Latest polled task facts. @returns Matching detail and inputs; changed progress stays visible with a required refresh. */
    read(runId: string, ttlMs: number, now: number, task?: AnalysisTask): CachedAnalysis | undefined {
      if (saved && (now < saved.fetchedAt || now - saved.fetchedAt >= ttlMs)) saved = undefined
      if (saved?.detail.task.runId !== runId) return undefined
      // 推送会先更新任务状态，逐图结果稍后读取；只读成功快照才能消除 stale 标记。
      if (JSON.stringify(task ?? saved.detail.task) !== JSON.stringify(saved.taskAtRead)) return { ...saved, detail: task ? { ...saved.detail, task } : saved.detail, stale: true }
      return saved
    },
    /** @param runId Task to revoke; omission clears the owning authorization scope. */
    invalidate(runId?: string): void { if (runId === undefined || saved?.detail.task.runId === runId) saved = undefined },
  }
}
