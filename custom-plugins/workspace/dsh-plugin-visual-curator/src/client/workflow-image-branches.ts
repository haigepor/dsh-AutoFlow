/** Planning cards share one bounded page; immutable image identities survive navigation and task continuation. */
import { wallpaperFailedStep, type WallpaperItem } from '../shared/wallpaper.ts'
import type { WorkflowPhase } from './workflow-node-state.ts'
import type { WallpaperStep } from './workflow-node-state.ts'

/** One column stays readable while the remaining images remain in paged groups. */
export const planningImagesPerPage = 4

/** The thumbnail directory is bounded independently from the single full-resolution plan read. */
export const imageNavigationPageSize = 12

/** Fixed presentation steps reuse saved processing evidence without creating additional work. */
export const imageWorkflowStages = [
  { stage: 'original', kind: 'downloading', title: 'wallpaperStageOriginal' },
  { stage: 'planning', kind: 'planning', title: 'wallpaperPlanning' },
  { stage: 'geometry', kind: 'planning', title: 'wallpaperStageGeometry' },
  { stage: 'rendering', kind: 'rendering', title: 'wallpaperStageRendering' },
  { stage: 'reviewing', kind: 'reviewing', title: 'wallpaperStageReview' },
  { stage: 'final', kind: 'reviewing', title: 'wallpaperStageFinal' },
] as const

/** A presentation step can share processing evidence with another step. */
export type ImageWorkflowStage = typeof imageWorkflowStages[number]['stage']

/** @param lane Batch layout identity. @param stage Presentation step. @returns An identity independent of the selected image. */
export function fixedImageWorkflowNodeId(lane: string, stage: ImageWorkflowStage): string {
  const step = imageWorkflowStages.find(entry => entry.stage === stage)!
  return `${lane}:image-step:${stage}:${step.kind}`
}

/** @param lane Stable batch identity. @param imageId Immutable source identity. @param kind Image processing step. @returns A step identity that cannot collide with another image or stage. */
export function imageWorkflowNodeId(lane: string, imageId: string, kind: WallpaperStep): string {
  return `${planningImageNodeId(lane, imageId)}:${kind}`
}

/** @param kind Image processing step. @param item Saved image evidence. @param status Owning task lifecycle. @param attempt Selected saved revision; absence uses the latest. @returns This image's stage status without another image's aggregate progress. */
export function imageWorkflowPhase(kind: WallpaperStep, item: WallpaperItem, status: string, attempt = item.attempts.at(-1)): WorkflowPhase {
  const latest = attempt === item.attempts.at(-1), failed = latest ? wallpaperFailedStep(item) : undefined
  if (failed === kind) return item.errorCode ? 'failed' : 'attention'
  if (kind === 'downloading' && item.originalId) return 'completed'
  if (kind === 'planning') return planningImagePhase(latest ? item : { ...item, attempts: attempt ? [attempt] : [] }, latest ? status : 'completed')
  if (kind === 'rendering' && attempt?.outputId) return 'completed'
  if (kind === 'reviewing' && attempt?.review) return Object.values(attempt.review.checks).every(check => check.result === 'satisfied') ? 'completed' : 'attention'
  if (kind !== 'downloading' && !item.originalId || kind === 'rendering' && (!attempt || attempt.checks.length > 0 || attempt.plan.mode === 'uncertain') || kind === 'reviewing' && !attempt?.outputId) return 'blocked'
  if (latest && item.status === kind) {
    if (['created', 'running', 'pausing', 'cancelling'].includes(status)) return 'running'
    if (['paused', 'interrupted'].includes(status)) return 'paused'
  }
  return status === 'cancelled' ? 'cancelled' : 'queued'
}

/** @param offset Selected absolute image index. @param pageSize Active page size. @returns First image index of the shared request window. */
export function planningWindowStart(offset: number, pageSize: number): number {
  return Math.floor(offset / pageSize) * pageSize
}

/** @param lane Stable batch identity. @param imageId Immutable source identity. @returns A node identity independent of its group or position. */
export function planningImageNodeId(lane: string, imageId: string): string {
  const bytes = new TextEncoder().encode(imageId), encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `${lane}:planning-image:${encoded}`
}

/** @param id Canvas node identity. @returns Its parent batch when this is an image card. */
export function planningImageLane(id: string): string | undefined {
  const at = id.lastIndexOf(':planning-image:')
  return at > 0 ? id.slice(0, at) : undefined
}

/** @param item Saved per-image evidence. @param status Owning task lifecycle. @returns Planning state, independent of later rendering or review failures. */
export function planningImagePhase(item: WallpaperItem, status: string): WorkflowPhase {
  const attempt = item.attempts.at(-1)
  if (wallpaperFailedStep(item) === 'downloading') return 'blocked'
  if (item.status === 'planning' && ['created', 'running', 'pausing', 'cancelling'].includes(status)) return 'running'
  if (item.status === 'planning' && ['paused', 'interrupted'].includes(status)) return 'paused'
  if (wallpaperFailedStep(item) === 'planning') return item.errorCode ? 'failed' : 'attention'
  if (attempt?.checks.length || attempt?.plan.mode === 'uncertain') return 'attention'
  if (attempt) return 'completed'
  if (status === 'cancelled') return 'cancelled'
  return item.originalId ? 'queued' : 'blocked'
}
