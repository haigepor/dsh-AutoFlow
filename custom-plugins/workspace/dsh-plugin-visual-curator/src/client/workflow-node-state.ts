/** Node presentation follows committed per-image evidence, independently from Run lifecycle. */
import type { WorkflowNodeKind } from './workflow-canvas-layout.ts'

/** Business status shared by node headers, connections and their accessible labels. */
export type WorkflowPhase = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'paused' | 'cancelled' | 'attention'
/** Activity and counts for one processing stage. */
export interface WallpaperStage { phase: WorkflowPhase; done: number; total: number; failed: number; blocked: number; active: number }
/** Downstream stages use the same order as the per-image worker. */
export type WallpaperStep = Extract<WorkflowNodeKind, 'downloading' | 'planning' | 'rendering' | 'reviewing'>

/** @param status Actual task lifecycle. @returns Its node presentation before per-image evidence is available. */
export function workflowPhase(status: string | undefined): WorkflowPhase {
  if (status === 'running' || status === 'pausing' || status === 'cancelling') return 'running'
  if (status === 'created' || status === 'pending') return 'queued'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'paused' || status === 'interrupted') return 'paused'
  if (status === 'cancelled' || status === 'stopped') return 'cancelled'
  return 'idle'
}

/**
 * @param kind Processing stage.
 * @param status Owning Run lifecycle.
 * @param total Frozen source count.
 * @param counts Host-derived per-stage facts.
 * @returns Activity only for steps actually running; upstream failures block later steps.
 */
export function wallpaperStage(kind: WallpaperStep, status: string, total: number, counts: Record<string, number>): WallpaperStage {
  const key = kind === 'downloading' ? 'downloaded' : kind === 'planning' ? 'planned' : kind === 'rendering' ? 'rendered' : 'reviewed'
  const done = counts[key] ?? 0, active = counts[kind] ?? 0, failed = counts[`${kind}Failed`] ?? 0, blocked = counts[`${kind}Blocked`] ?? 0, attention = counts[`${kind}Attention`] ?? 0
  const result = (phase: WorkflowPhase): WallpaperStage => ({ phase, done, total, failed, blocked, active })
  const running = ['created', 'running', 'pausing', 'cancelling'].includes(status)
  if (active > 0 && running) return result('running')
  if (failed > 0) return result(kind === 'downloading' && done > 0 ? 'attention' : 'failed')
  if (total > 0 && done === total) return result(kind === 'reviewing' && (counts.passed ?? 0) < total ? 'attention' : 'completed')
  if (attention > 0) return result('attention')
  if (blocked > 0 && done + blocked >= total) return result(done ? 'attention' : 'blocked')
  if (status === 'cancelled') return result('cancelled')
  if (status === 'paused' || status === 'interrupted') return result(active > 0 || kind === 'downloading' && (counts.queued ?? 0) > 0 ? 'paused' : 'queued')
  if (running) return result('queued')
  if (status === 'failed') return result(active > 0 || kind === 'downloading' && !done ? 'failed' : 'blocked')
  return result('queued')
}

/** Locale keys remain owned by the workbench dictionaries. */
export const workflowPhaseKeys = { idle: 'workflowPhaseIdle', queued: 'workflowPhaseQueued', running: 'workflowPhaseRunning', completed: 'workflowPhaseCompleted', failed: 'workflowPhaseFailed', blocked: 'workflowPhaseBlocked', paused: 'workflowPhasePaused', cancelled: 'workflowPhaseCancelled', attention: 'workflowPhaseAttention' } as const
