/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Dataset labels adapt persisted export phases to the shared task presentation. */
import type { DatasetEntry } from '../shared/datasets.ts'
import { datasetActive, type DatasetClientState, type DatasetSubmission } from './dataset-store.ts'
import { createBackgroundTaskCard } from './background-task-card.tsx'
import type { WorkbenchText } from './workbench-locale.ts'

/** @param state Current owner-private observation. @param styleId Current collection. @param profileId Optional specific profile. @returns The pending submission or most recent relevant task. */
export function datasetNotice(state: DatasetClientState, styleId: string, profileId?: string): { submission?: DatasetSubmission; entry?: DatasetEntry } {
  const submission = state.submissions.filter(item => item.styleId === styleId && (!profileId || item.profileId === profileId)).at(-1)
  const entry = state.entries.filter(row => row.styleId === styleId && (!profileId || row.modelProfileId === profileId) && (!submission || row.runId === submission.runId) && !state.dismissed.includes(row.id) && (datasetActive(row.status) || state.watched.includes(row.id))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  return { ...(submission ? { submission } : {}), ...(entry ? { entry } : {}) }
}

/** @param React Host runtime. @param ui Shared presentation primitives. @returns A dataset card reused by the page and content overlay. */
export function createDatasetProgress(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const Card = createBackgroundTaskCard(React, ui)
  return function DatasetProgress({ entry, submission, t, onOpen, onView, onRetry, onRefresh, onDismiss, readError = false, overlay = false }: { entry?: DatasetEntry | undefined; submission?: DatasetSubmission | undefined; t: WorkbenchText; onOpen?(): void; onView?(): void; onRetry?(): void; onRefresh?(): void; onDismiss?(): void; readError?: boolean; overlay?: boolean }) {
    if (!entry && !submission) return null
    const active = submission ? submission.status !== 'unknown' : !!entry && datasetActive(entry.status), unknown = submission?.status === 'unknown'
    const progress = entry?.progress
    const phase = progress ? t(({ verifying: 'datasetVerifying', samples: 'datasetWritingSamples', files: 'datasetWritingFiles', saving: 'datasetCommitting' } as const)[progress.phase]) : t('datasetSubmitting')
    const label = unknown ? t('datasetAckUnknown') : active ? phase : t(entry?.status === 'completed' ? 'datasetReady' : 'datasetFailed')
    return <Card id={entry?.id ?? submission!.operationId} kind="dataset" status={submission?.status ?? entry!.status} active={active} success={entry?.status === 'completed'} progressLabel={t('datasetProgress')} progress={progress}
      label={<>{label}{active && progress && progress.total > 0 && <> <strong>{progress.completed} / {progress.total}</strong></>}</>}
      hint={unknown ? t('datasetAckUnknownHint') : readError ? t('datasetLoadError') : overlay || active ? t('datasetBackgroundHint') : entry?.status === 'completed' ? t('datasetSavedHint') : t('profileExportError')}
      actions={!overlay && <div className="vc-dataset-actions">{unknown && onRetry && <ui.Button size="sm" variant="outline" onClick={onRetry}>{t('datasetRetryAck')}</ui.Button>}{readError && onRefresh && <ui.Button size="sm" variant="outline" onClick={onRefresh}>{t('refresh')}</ui.Button>}{active && onOpen && <ui.Button size="sm" variant="ghost" onClick={onOpen}>{t('openProfile')}</ui.Button>}{onView && <ui.Button size="sm" variant="ghost" onClick={onView}>{t('viewDatasets')}</ui.Button>}{!active && onDismiss && <ui.Button size="sm" variant="ghost" onClick={onDismiss}>{t('dismiss')}</ui.Button>}</div>} />
  }
}
