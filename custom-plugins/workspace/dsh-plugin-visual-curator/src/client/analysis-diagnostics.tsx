/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Safe saved-request diagnostics remain separate from current execution status. */
import type { AnalysisDetail, AnalysisMessage, AnalysisRequest, AnalysisTask } from '../shared/analysis-process.ts'
import type { WorkbenchText } from './workbench-locale.ts'

/** A failed receipt or a retained response whose receipt is no longer available. */
export interface AnalysisIssue { id: string; request: AnalysisRequest | undefined; message: AnalysisMessage | undefined }

/** @param detail Authorized task details. @returns Failed attempts without counting a receipt and its message twice. */
export function analysisIssues(detail: AnalysisDetail): AnalysisIssue[] {
  const messages = detail.process?.messages ?? []
  const requests = detail.requests.filter(request => request.error || request.state === 'outcome-unknown')
  const identities = new Set(requests.map(request => request.requestId))
  return [...requests.map(request => ({ id: request.requestId, request, message: messages.find(message => message.requestId === request.requestId) })),
    ...messages.filter(message => ['failed', 'interrupted', 'cancelled'].includes(message.state) && (!message.requestId || !identities.has(message.requestId))).map(message => ({ id: `message-${message.sequence}`, request: undefined, message }))]
}

/** @param task Latest execution facts. @returns Whether the dialog may offer an explicit continuation. */
export function analysisCanContinue(task: AnalysisTask): boolean {
  return ['paused', 'interrupted', 'failed'].includes(task.status) && (task.continuation?.allowed ?? task.status !== 'failed')
}

/** @param task Latest execution facts. @param t Current locale. @returns Continuation guarantee or the saved-budget reason it is unavailable. */
export function analysisContinuationHint(task: AnalysisTask, t: WorkbenchText): string {
  const reason = task.continuation?.reason
  if (task.outcome === 'budget-exhausted') return t('analysisResumeBudget')
  return t(reason === 'deadline' ? 'analysisResumeDeadline' : reason === 'vision-limit' ? 'analysisResumeVisionLimit' : reason === 'not-retryable' ? 'analysisResumeNotRetryable' : reason === 'cancelled' ? 'analysisResumeCancelled' : analysisCanContinue(task) ? 'analysisResumeCheckpointHint' : 'analysisResumeUnavailable')
}

/** @param failure Saved safe error fields. @param t Current locale. @returns Localized known failures, preserving only the Host's safe fallback. */
export function analysisFailureSummary(failure: NonNullable<AnalysisRequest['error']>, t: WorkbenchText): string {
  if (failure.code === 'capability-unavailable' && failure.stage === 'workflow') return t('analysisFailureUnknownCause')
  if (failure.code === 'capability-unavailable') return t('analysisFailureCapability')
  if (failure.code === 'remote-request-failed' || failure.code === 'remote-timeout') return t('analysisFailureNetwork')
  if (failure.code === 'ATTACHMENT_WRITE_FAILED' || failure.code === 'ATTACHMENT_READ_FAILED') return t('analysisFailureAttachmentStore')
  if (['TOO_MANY_IMAGES', 'IMAGES_TOO_LARGE', 'IMAGE_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS', 'IMAGE_DIMENSION_TOO_LARGE'].includes(failure.code)) return t('analysisFailureImageLimit')
  if (failure.code.startsWith('ATTACHMENT_') || ['INVALID_IMAGE', 'INVALID_IMAGE_BASE64', 'IMAGE_TYPE_MISMATCH', 'UNSUPPORTED_IMAGE_TYPE', 'INVALID_ATTACHMENT_REF'].includes(failure.code)) return t('analysisFailureImage')
  return failure.code === 'request-timeout' ? t('analysisFailureTimeout') : failure.code === 'cancelled' ? t('analysisFailureInterrupted') : failure.code === 'vision-output-truncated' ? t('analysisTruncated') : failure.code === 'vision-invalid-output' ? t('analysisInvalidOutput') : failure.code === 'vision-context-compaction-failed' ? t('analysisCompactionFailed') : failure.safeMessage || t('analysisFailureUnknown')
}

/** @param React Shared runtime. @param ui Native primitives. @returns Request history and failure panels without additional data or model requests. */
export function createAnalysisDiagnostics(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, Tag } = ui
  function Failure({ error, t }: { error: AnalysisRequest['error']; t: WorkbenchText }) {
    return <div className="vc-diagnostic-failure"><p>{error ? analysisFailureSummary(error, t) : t('analysisFailureUnknown')}</p>{error && <dl className="vc-diagnostic-facts"><div><dt>{t('analysisFailureCode')}</dt><dd><code>{error.code}</code></dd></div>{error.stage && <div><dt>{t('analysisFailureStage')}</dt><dd>{error.stage}</dd></div>}</dl>}{error?.suggestedAction && <p className="vc-diagnostic-next"><strong>{t('analysisFailureAction')}</strong>{error.code === 'request-timeout' ? t('analysisResumeCheckpointHint') : error.suggestedAction}</p>}</div>
  }
  return function AnalysisDiagnostics({ detail, mode, t, onLocate }: { detail: AnalysisDetail; mode: 'requests' | 'diagnostics'; t: WorkbenchText; onLocate(sequence: number): void }) {
    const task = detail.task, messages = detail.process?.messages ?? [], issues = analysisIssues(detail)
    const recovered = task.status === 'completed' && task.outcome !== 'budget-exhausted'
    const rows: AnalysisIssue[] = mode === 'requests' ? detail.requests.map(request => ({ id: request.requestId, request, message: messages.find(message => message.requestId === request.requestId) })) : issues
    return <div className="vc-analysis-diagnostics">
      {mode === 'diagnostics' && <section className="vc-diagnostic-overview"><div><Tag tone={recovered ? 'success' : task.status === 'failed' ? 'danger' : 'neutral'}>{t(task.outcome === 'budget-exhausted' ? 'budgetExhausted' : recovered ? 'completed' : task.status)}</Tag><span>{t('analysisAttemptSaved')} <strong>{task.observed} / {task.total}</strong></span></div><p>{recovered ? t('analysisRecoveredHint') : analysisContinuationHint(task, t)}</p></section>}
      {mode === 'diagnostics' && task.error && !recovered && <section className="vc-diagnostic-card" aria-label={t('analysisCurrentFailure')}><h3>{t('analysisCurrentFailure')}</h3><Failure error={task.error} t={t} /></section>}
      {rows.map(({ id, request, message }) => {
        const failed = !!request?.error || request?.state === 'outcome-unknown' || !!message && ['failed', 'interrupted', 'cancelled'].includes(message.state)
        const interrupted = request?.error?.code === 'cancelled' || message?.state === 'interrupted' || message?.state === 'cancelled'
        const at = request?.createdAt ?? message?.at, date = at ? new Date(at) : undefined
        const operation = request?.operation ?? message?.kind
        return <article className="vc-diagnostic-card" key={id} data-analysis-request={request?.requestId}>
          <header><div><strong>{t(operation === 'summarize' || operation === 'summary' ? 'processSummary' : operation === 'analyze' || operation === 'analysis' ? 'analysisBatch' : 'analysisAuxiliaryRequest')}{message?.batch !== undefined && <> {message.batch}</>}</strong><Tag tone={failed ? 'warning' : request?.state === 'committed' ? 'success' : 'info'}>{t(failed && recovered ? interrupted ? 'analysisHistoricalInterrupted' : 'analysisHistoricalFailure' : failed ? 'analysisRequestUnconfirmed' : request?.state === 'committed' ? 'analysisRequestCommitted' : 'analysisRequestPending')}</Tag></div>{message && <Button size="sm" variant="ghost" onClick={() => onLocate(message.sequence)}>{t('analysisLocateAttempt')}</Button>}</header>
          <dl className="vc-diagnostic-facts"><div><dt>{t('analysisRequestTime')}</dt><dd>{date && !Number.isNaN(date.valueOf()) ? date.toLocaleString() : '—'}</dd></div><div><dt>{t('galleryPhotoUnit')}</dt><dd>{request?.imageIds.length ?? message?.imageIds.length ?? 0}</dd></div>{request && <><div><dt>{t('analysisRequestIdentity')}</dt><dd><code>{request.requestId}</code></dd></div><div><dt>{t('model')}</dt><dd>{request.model ?? '—'}</dd></div></>}</dl>
          {failed && <Failure error={request?.error} t={t} />}
          {request?.state === 'outcome-unknown' && <p className="vc-diagnostic-notice">{t('analysisRequestUnknownHint')}</p>}
        </article>
      })}
      {!rows.length && <p className="vc-chat-empty">{t(mode === 'requests' ? 'analysisRequestsEmpty' : 'analysisNoFailures')}</p>}
    </div>
  }
}
