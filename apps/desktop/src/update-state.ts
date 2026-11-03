/** Browser-safe desktop update data shared by the main process and isolated renderers. */
import type { DesktopReleaseNotes } from './update-release-notes.ts'

/** Desktop release update state rendered by desktop-owned UI. */
export type DesktopUpdatePreparationFailureKind = 'stop-failed' | 'tasks-changed' | 'tasks-unavailable' | 'fullscreen-timeout'

export type { ArtifactDownloadChoice as DesktopDownloadChoice, ArtifactDownloadProgress as DesktopDownloadProgress } from '@deepseek-ai/dsh-plugin-manager/src/artifact-download-types.ts'
import type { ArtifactDownloadProgress as DesktopDownloadProgress } from '@deepseek-ai/dsh-plugin-manager/src/artifact-download-types.ts'

export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  /** Checked official notes; absent for older feeds or invalid optional note data. */
  readonly releaseNotes?: DesktopReleaseNotes
  readonly message?: string
  /** Main-owned diagnostics without subprocess output or credentials; hidden until expanded. */
  readonly technicalDetails?: string
  readonly percent?: number
  /** Shell-only download controls and measured transport progress, never installation authorization. */
  readonly download?: DesktopDownloadProgress
  readonly failedOperation?: 'check' | 'download' | 'install'
  /** Main-owned preparation cause; UI wording is selected by the active locale. */
  readonly preparationFailure?: DesktopUpdatePreparationFailureKind
}
