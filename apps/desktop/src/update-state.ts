/** Browser-safe desktop update data shared by the main process and isolated renderers. */

/** Desktop release update state rendered by desktop-owned UI. */
export type DesktopUpdatePreparationFailureKind = 'stop-failed' | 'tasks-changed' | 'tasks-unavailable' | 'fullscreen-timeout'

/** Shell-selected source; custom prefixes apply only to public GitHub Release files. */
export interface DesktopDownloadChoice { readonly source: string; readonly customPrefix?: string }

/** Measured transport data; these fields never authorize installation. */
export interface DesktopDownloadProgress {
  readonly stage: 'idle' | 'probing' | 'downloading' | 'paused' | 'verifying' | 'failed'
  readonly choice: DesktopDownloadChoice
  readonly source?: string
  readonly transferred: number
  readonly total: number
  readonly bytesPerSecond: number
  readonly remainingSeconds?: number
  readonly sources: readonly { readonly id: string; readonly name: string }[]
}

export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
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
