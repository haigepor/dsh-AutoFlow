/** Navigation identifies saved work without starting or changing that work. */
import type { ImageView, RunView } from './contract.ts'

/** The workbench owns the active view; the canvas reports its current saved-image location. */
export interface ExecutionNavigation {
  view: 'canvas' | 'results' | 'image'
  sourceRunId?: string | undefined
  imageVersionId?: string | undefined
  /** Pinned wallpaper task for historical reads; absence follows the latest child. */
  runId?: string | undefined
  serial: number
}

/** Immutable source identity and current image selection, independent of viewport and node layout. */
export interface WorkflowLocation {
  sourceRunId: string
  runId: string
  sessionId?: string | undefined
  imageVersionId?: string | undefined
  imageIndex: number
  imageCount: number
}

/** @param run Selected saved task. @returns Its source batch, retaining wallpaper continuation ancestry. */
export function workflowSourceRunId(run: RunView | undefined): string | undefined {
  return run?.wallpaper?.sourceRunId ?? (run?.kind === 'search' || run?.kind === 'crop' && !run.wallpaperTask ? run.runId : undefined)
}

/** @param run Saved source or wallpaper task. @param image Result displayed by that task. @returns Its exact directory identity, or no established image workflow. */
export function workflowImageVersionId(run: RunView | undefined, image: ImageView): string | undefined {
  return image.workflowImageVersionId ?? run?.wallpaper?.outputs.find(output => output.imageVersionId === image.imageVersionId || output.sourceImageVersionId === image.imageVersionId)?.sourceImageVersionId
}
