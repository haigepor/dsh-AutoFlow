/** Browser-facing projections keep private storage paths, credentials and media locators on the Host. */
export type Dimension = 'color' | 'lighting' | 'texture' | 'subject' | 'composition' | 'density' | 'depth'
export type Workspace = 'styles' | 'samples' | 'tasks' | 'data'
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type ActionArgs = Record<string, Json>

/** A persisted rule, including the references needed to inspect and resolve its evidence. */
export interface RuleView {
  ruleId: string
  dimension: Dimension
  statement: string
  strength: 'required' | 'preferred' | 'reference-only'
  stage: 'source' | 'final'
  confirmed: boolean
  condition: string
  exceptions: string[]
  supportRefs: string[]
  counterRefs: string[]
}

/** Immutable release and candidate identities remain explicit in every launch form. */
export interface VersionView {
  id: string
  label: string
  contentDigest: string
  validation?: 'provisional' | 'evaluated'
  rules?: RuleView[]
  evaluationIds?: string[]
}

/** The mutable style aggregate and its committed, immutable versions. */
export interface StyleView {
  styleId: string
  name: string
  revision: number
  draftId: string
  draftRevision: number
  archived: boolean
  defaultReleaseId?: string
  rules: RuleView[]
  conflicts: string[]
  referenceIds: string[]
  feedbackIds?: string[]
  releases: VersionView[]
  candidates: VersionView[]
}

/** A visible image version and its authorized association, never an upstream media URL. */
export interface ImageView {
  imageVersionId: string
  assetId: string
  familyId: string
  width: number
  height: number
  kind: 'normalized' | 'preview' | 'crop'
  previewPath: string
  name: string
  source: string
  exportPermission: 'references-only' | 'bytes-allowed'
  groupingStatus: 'unreviewed' | 'confirmed'
  reviewQueueReasons?: ('ordinary-sample' | 'unknown' | 'technical-failed' | 'human-model-disagreement' | 'new-source-group')[]
  referenceId?: string
  styleId?: string
  role?: 'positive' | 'negative' | 'undecided'
  intent?: 'overall' | 'dimensions'
  dimensions?: Dimension[]
  runId?: string
  releaseId?: string
  usageRevisionId?: string
  parentImageVersionId?: string
  candidateId?: string
  effectivePixelRect?: { x: number; y: number; width: number; height: number }
  verdict?: 'pass' | 'reject' | 'needs-review'
  technicalFailure?: string
  reason?: string
  feedbackHead?: string
  feedbackHeads?: Record<string, string>
  feedbackContext?: {
    styleId: string
    standard: { kind: 'release'; releaseId: string } | { kind: 'draft'; draftId: string; draftRevision: number }
    usage: { kind: 'none' } | { kind: 'revision'; usageRevisionId: string }
    runId?: string
    taskBriefDigest: string
  }
  feedbackHistory?: FeedbackView[]
}

/** The exact feedback head and its history can be revised without overwriting prior judgments. */
export interface FeedbackView {
  feedbackId: string
  kind: string
  value: string
  scope: 'task-only' | 'style-candidate'
  dimensions: Dimension[]
  comment: string
  createdAt: string
}

/** Immutable output requirements are separate from style preferences. */
export interface UsageView {
  usageRevisionId: string
  name: string
  aspectP: number
  aspectQ: number
  targetWidth: number
  targetHeight: number
  protectedContent: string[]
  safeRegions: { x: number; y: number; width: number; height: number; strength: 'required' | 'preferred'; description: string }[]
}

/** Durable run state is independent of its current process job. */
export interface RunView {
  runId: string
  jobId?: string
  kind: 'search' | 'crop' | 'analyze' | 'evaluate' | 'export'
  status: 'created' | 'running' | 'pausing' | 'paused' | 'interrupted' | 'cancelling' | 'cancelled' | 'completed' | 'failed'
  stage?: string
  outcome?: string
  releaseId?: string
  usageRevisionId?: string
  taskBrief: string
  counts: Record<string, number>
  results: ImageView[]
  error?: SafeFailure
  warnings: string[]
  pageToken?: string
}

/** Human-confirmed family assignments produce a new split on every change. */
export interface SplitView {
  splitId: string
  label: string
  assignments: { familyId: string; split: 'learning' | 'development' | 'holdout' }[]
}

/** Metric numerators and denominators remain visible when a ratio is unavailable. */
export interface EvaluationView {
  reportId: string
  leftId: string
  rightId: string
  splitId: string
  metrics: { name: string; numerator: number; denominator: number; value: number | null; side?: 'left' | 'right' }[]
  counts: Record<string, number>
  warnings: string[]
  items?: { imageVersionId: string; left: string; right: string }[]
}

/** A ready export is downloadable only through a Host-authorized, same-origin resource. */
export interface ExportView {
  exportId: string
  kind: string
  status: string
  downloadPath?: string
  checksum?: string
  preview?: string
  exclusions?: { reason: string; count: number }[]
}

/** Deployment fields are edited through configEditor; secret values use DSH credentials separately. */
export interface ConfigurationView {
  revision: string
  sourceConfigured: boolean
  visionConfigured: boolean
  sourceCredentialConfigured: boolean
  visionCredentialConfigured: boolean
  source: {
    id: string; endpoint: string; method: 'GET' | 'POST'; credentialRef: string
    queryField: string; cursorField: string; pageSizeField: string
    itemsPointer: string; idPointer: string; previewPointer: string; originalPointer: string
    widthPointer: string; heightPointer: string; nextCursorPointer: string
    allowedMediaOrigins: string[]; lookupEndpoint: string
  }
  vision: { endpoint: string; model: string; credentialRef: string; supportsMultipleImages: boolean; supportsJson: boolean; localOrigin: string; vendorVersion: string | null }
  limits: { maxVisionCalls: number; maxSearchPages: number; maxCandidates: number; maxDownloadBytes: number; maxCropCandidatesPerImage: number; maxConcurrentRequests: number; maxRetryAttempts: number; deadlineMs: number; pollIntervalMs: number; pageSize: number; maxImportFiles: number; maxImportBytes: number }
}

/** Complete profile projection; polling refreshes data while viewing state stays in the Client store. */
export interface CuratorSnapshot {
  styles: StyleView[]
  images: ImageView[]
  usages: UsageView[]
  runs: RunView[]
  splits: SplitView[]
  evaluations: EvaluationView[]
  exports: ExportView[]
  suggestions: { suggestionId: string; imageVersionId?: string; text: string; status: 'pending' | 'accepted' | 'dismissed' }[]
  configuration: ConfigurationView
  nextPageToken?: string
}

/** Failures contain safe user guidance and never raw provider errors. */
export interface SafeFailure { code: string; stage: string; retryable: boolean; safeMessage: string; suggestedAction: string }

/** Runtime-validated operation envelope shared by Client, Agent and the Host service. */
export interface ClientActionInput { operation: string; args: ActionArgs }

/** Client files retain individual intent, so a mixed batch can report partial success accurately. */
export interface ImportFileInput {
  name: string
  mime: string
  base64: string
  role: 'positive' | 'negative' | 'undecided'
  intent: 'overall' | 'dimensions'
  dimensions: Dimension[]
}

/** Exported so Host transport and UI agree on the eight model-visible capabilities. */
export const agentOperations = {
  visual_style_list: 'style-list', visual_style_get: 'style-get', visual_search_start: 'search-start',
  visual_crop_start: 'crop-start', visual_run_get: 'run-get', visual_feedback_suggest: 'feedback-suggest',
  visual_export_start: 'export-start', visual_export_get: 'export-get',
} as const
