/** Select a saved task without changing its frozen input or history. */
import type { SearchBatch } from '../shared/search-batches.ts'
import type { DatasetEntry } from '../shared/datasets.ts'
import { workflowPhase, type WorkflowPhase } from './workflow-node-state.ts'
const active = (status: string) => ['created', 'running', 'pausing', 'cancelling'].includes(status)
/** @param batches Loaded task history in server order. @param selected Explicit task or launch identity. @returns Selected task, then active work, then the latest loaded task. */
export function preferredWorkflowBatch(batches: readonly SearchBatch[], selected: string): SearchBatch | undefined {
  return batches.find(batch => batch.runId === selected || !!selected && batch.launchId === selected) ?? batches.find(batch => active(batch.status) || !!batch.wallpaper && active(batch.wallpaper.status)) ?? batches[0]
}

/** @param wallpaper Saved wallpaper summary. @returns Completion only when all requested outputs passed; failed steps retain their failure state. */
export function workflowWallpaperPhase(wallpaper: NonNullable<SearchBatch['wallpaper']>): WorkflowPhase {
  if (wallpaper.status !== 'completed') return workflowPhase(wallpaper.status)
  if (wallpaper.errorCode || Object.entries(wallpaper.counts ?? {}).some(([key, count]) => key.endsWith('Failed') && count > 0)) return 'failed'
  return wallpaper.attention > 0 || wallpaper.passed < wallpaper.total ? 'attention' : 'completed'
}

/** @param batch Saved source and optional downstream task. @returns Status of the complete selected workflow, including its handoff and partial results. */
export function workflowBatchPhase(batch: SearchBatch): WorkflowPhase {
  if (batch.wallpaper) return workflowWallpaperPhase(batch.wallpaper)
  if (batch.status !== 'completed') return workflowPhase(batch.status)
  if (batch.postProcessingError) return 'failed'
  if (batch.wallpaperRequested && batch.matched > 0) return 'queued'
  if (batch.targetCount && batch.matched < batch.targetCount) return 'attention'
  return 'completed'
}

/** @param current Current collection analysis phase. @param launchProfileId Frozen launch profile, when present. @param currentProfileId Editable collection profile. @param dataset Loaded package evidence. @returns Historical launches follow their own saved package; missing package evidence remains queued. */
export function workflowReferencePhase(current: WorkflowPhase, launchProfileId: string | undefined, currentProfileId: string | undefined, dataset: Pick<DatasetEntry, 'modelProfileId' | 'status'> | undefined): WorkflowPhase {
  if (!launchProfileId || launchProfileId === currentProfileId) return current
  return dataset?.modelProfileId === launchProfileId ? workflowPhase(dataset.status) : 'queued'
}
