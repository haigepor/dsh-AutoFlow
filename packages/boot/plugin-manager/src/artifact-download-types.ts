/** Browser-safe artifact progress; importing these types loads no Cordis Host declarations. */
/** Public artifact route preference; custom prefixes never receive origin credentials. */
export interface ArtifactDownloadChoice {
  /** Automatic selection, a declared public source ID, or custom. */
  readonly source: string
  /** HTTPS public-byte prefix without credentials, query or fragment; used only with custom. */
  readonly customPrefix?: string
}

/** Received bytes, independent of sparse file allocation; completion does not authorize installation. */
export interface ArtifactDownloadProgress {
  readonly stage: 'idle' | 'probing' | 'downloading' | 'paused' | 'verifying' | 'failed'
  readonly choice: ArtifactDownloadChoice
  readonly source?: string
  readonly transferred: number
  readonly total: number
  readonly bytesPerSecond: number
  readonly remainingSeconds?: number
  readonly sources: readonly { readonly id: string; readonly name: string }[]
}
