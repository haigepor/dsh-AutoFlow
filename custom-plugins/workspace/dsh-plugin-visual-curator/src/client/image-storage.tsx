/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Human-confirmed cleanup retains every committed original, derivative and hidden historical reference. */
import { z } from 'zod'
import { imageStorageViewSchema, imageStorageCleanedSchema, type ImageStorageView } from '../shared/image-storage.ts'
import type { DirectCropInvoke } from './direct-crop.tsx'
import type { WorkbenchProps } from './workbench.tsx'
import type { ConfigurationView } from './contract.ts'
import type { WorkbenchText } from './workbench-locale.ts'

const failureSchema = z.object({ code: z.string(), stage: z.string() })
const directoryReply = z.union([z.strictObject({ directory: z.string() }), z.strictObject({ cancelled: z.literal(true) })])
const gibibyte = 1024 ** 3
const size = (bytes: number) => bytes >= gibibyte ? `${(bytes / gibibyte).toFixed(3)} GiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB`

/** @param React Shared React instance. @param ui Existing modal and form primitives. @returns Storage management dialog. */
export function createImageStorageDialog(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  return function ImageStorageDialog({ invoke, actions, configuration, t, onClose, onChanged }: { invoke: DirectCropInvoke; actions: WorkbenchProps['actions']; configuration: ConfigurationView; t: WorkbenchText; onClose(): void; onChanged(): void }) {
    const [view, setView] = React.useState<ImageStorageView | null>(null), [busy, setBusy] = React.useState<'read' | 'clean' | 'save' | 'pick' | 'move' | null>('read')
    const [destination, setDestination] = React.useState('')
    const migrationRequest = React.useRef<{ operationId: string; directory: string; sourceDirectory: string; confirm: true }>()
    const [error, setError] = React.useState(''), [notice, setNotice] = React.useState(''), [limit, setLimit] = React.useState(''), [confirming, setConfirming] = React.useState(false)
    const lifetime = React.useRef(new AbortController()), id = React.useId()
    const failureText = (failure: unknown, fallback: 'imageStorageReadError' | 'imageStorageCleanError' | 'imageStorageSaveError' | 'imageStorageMoveError') => {
      const parsed = failureSchema.safeParse(failure)
      if (parsed.success && parsed.data.stage === 'storage-migration') {
        if (parsed.data.code === 'storage-directory-not-empty' || parsed.data.code === 'owner-denied') return t('imageStorageDirectoryOwned')
        if (parsed.data.code === 'storage-directory-overlap') return t('imageStorageDirectoryOverlap')
        if (parsed.data.code === 'storage-space-insufficient') return t('imageStorageDirectorySpace')
        if (parsed.data.code === 'storage-checksum-mismatch') return t('imageStorageDirectoryChecksum')
        if (parsed.data.code === 'constraint-conflict') return t('imageStorageMovingBusy')
      }
      return t(parsed.success && parsed.data.code === 'revision-conflict' ? 'imageStorageChanged' : parsed.success && parsed.data.stage === 'image-storage' && parsed.data.code === 'constraint-conflict' ? 'imageStorageBusy' : fallback)
    }
    const refresh = async (signal: AbortSignal) => {
      setBusy('read'); setError(''); setNotice(''); setConfirming(false)
      try {
        const next = imageStorageViewSchema.parse(await invoke('image-storage-read', {}, signal))
        if (!signal.aborted) { setView(next); setLimit(String(next.limitBytes / gibibyte)) }
      } catch (failure) { if (!signal.aborted) setError(failureText(failure, 'imageStorageReadError')) }
      finally { if (!signal.aborted) setBusy(null) }
    }
    React.useEffect(() => {
      const controller = new AbortController(); lifetime.current = controller
      void refresh(controller.signal)
      return () => controller.abort()
    }, [])
    const migration = view?.migration, moving = migration?.status === 'running', unresolved = moving || migration?.status === 'blocked'
    React.useEffect(() => {
      if (!moving) return
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout>
      const poll = async () => {
        try {
          const next = imageStorageViewSchema.parse(await invoke('image-storage-read', {}, controller.signal))
          if (controller.signal.aborted) return
          setView(next); setError('')
          if (next.migration?.status !== 'running') { onChanged(); return }
        } catch (failure) { if (!controller.signal.aborted) setError(failureText(failure, 'imageStorageReadError')) }
        if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, configuration.limits.pollIntervalMs)
      }
      timer = setTimeout(() => { void poll() }, configuration.limits.pollIntervalMs)
      return () => { controller.abort(); clearTimeout(timer) }
    }, [moving, configuration.limits.pollIntervalMs])
    const pickDirectory = async () => {
      setBusy('pick'); setError('')
      const signal = lifetime.current.signal
      try {
        const result = directoryReply.parse(await invoke('image-storage-directory-pick', { title: t('imageStorageChooseDirectory') }, signal))
        if (!signal.aborted && 'directory' in result) { setDestination(result.directory); migrationRequest.current = undefined }
      } catch (failure) { if (!signal.aborted) setError(failureText(failure, 'imageStorageMoveError')) }
      finally { if (!signal.aborted) setBusy(null) }
    }
    const move = async (resume: boolean) => {
      if (!view) return
      const signal = lifetime.current.signal
      setBusy('move'); setError(''); setNotice(''); setConfirming(false)
      try {
        if (resume && migration) await invoke('image-storage-migration-resume', { id: migration.id }, signal)
        else {
          const request = migrationRequest.current ?? { operationId: crypto.randomUUID(), sourceDirectory: view.directory, directory: destination, confirm: true }
          migrationRequest.current = request
          await invoke('image-storage-migrate', request, signal)
        }
        if (!signal.aborted) { setDestination(''); await refresh(signal); onChanged() }
      } catch (failure) { if (!signal.aborted) setError(failureText(failure, 'imageStorageMoveError')) }
      finally { if (!signal.aborted) setBusy(null) }
    }
    const clean = async () => {
      if (!view) return
      const signal = lifetime.current.signal
      setBusy('clean'); setError(''); setNotice('')
      try {
        const next = imageStorageCleanedSchema.parse(await invoke('image-storage-clean', { revision: view.revision, confirm: true }, signal))
        if (!signal.aborted) { setView(next); setConfirming(false); setNotice(t('imageStorageCleaned').replace('{count}', String(next.freedFiles)).replace('{size}', size(next.freedBytes))); onChanged() }
      } catch (failure) { if (!signal.aborted) { setError(failureText(failure, 'imageStorageCleanError')); setConfirming(false) } }
      finally { if (!signal.aborted) setBusy(null) }
    }
    const nextLimit = Math.round(Number(limit) * gibibyte)
    const saveLimit = async () => {
      setBusy('save'); setError('')
      try {
        await actions.saveConfiguration({ revision: configuration.revision, source: {}, vision: {}, limits: { maxStorageBytes: nextLimit } })
        if (!lifetime.current.signal.aborted) { onChanged(); onClose() }
      } catch (failure) { if (!lifetime.current.signal.aborted) setError(failureText(failure, 'imageStorageSaveError')) }
      finally { if (!lifetime.current.signal.aborted) setBusy(null) }
    }
    return <ui.Modal open title={t('imageStorageTitle')} closeLabel={t('close')} onClose={onClose} className="vc-image-storage-modal" contentClassName="vc-image-storage-content" footer={<div className="vc-image-storage-actions"><ui.Button variant="ghost" disabled={busy !== null} onClick={() => { void refresh(lifetime.current.signal) }}><ui.IconRefreshOutlineRegular size={14} />{t('refresh')}</ui.Button><div><ui.Button variant="outline" onClick={confirming ? () => setConfirming(false) : onClose}>{t(confirming ? 'cancel' : 'close')}</ui.Button><ui.Button variant="primary" disabled={busy !== null || !view?.cleanupAllowed || !view.reclaimableFiles || !!error} onClick={() => { if (confirming) void clean(); else setConfirming(true) }}>{busy === 'clean' && <ui.StateDot state="ongoing" />}{t(confirming ? 'imageStorageConfirmClean' : 'imageStorageClean')}</ui.Button></div></div>}>
      <div className="vc-image-storage-body">
        {view ? <><section className="vc-image-storage-directory" aria-label={t('imageStorageDirectory')}>
          <div className="vc-image-storage-directory-heading"><strong>{t('imageStorageDirectory')}</strong><ui.Button variant="outline" disabled={busy !== null || unresolved || !view.cleanupAllowed || confirming} onClick={() => { void pickDirectory() }}>{t('imageStorageChooseDirectory')}</ui.Button></div>
          <code className="vc-image-storage-path">{view.directory}</code>
          <p>{t('imageStorageDirectoryHint')}</p>
          {destination && <div className="vc-image-storage-confirm"><span>{t('imageStorageDestination')}</span><code className="vc-image-storage-path">{destination}</code><p>{t('imageStorageMoveConfirm')}</p><ui.Button variant="primary" disabled={busy !== null || unresolved || !view.cleanupAllowed} onClick={() => { void move(false) }}>{t('imageStorageStartMove')}</ui.Button></div>}
          {migration && <div className="vc-image-storage-transfer" role="status">
            <div className="vc-image-storage-directory-heading"><strong>{t(migration.status === 'completed' ? 'imageStorageMoveComplete' : migration.status === 'running' ? migration.phase === 'preparing' ? 'imageStorageMovePreparing' : migration.phase === 'copying' ? 'imageStorageMoveCopying' : migration.phase === 'verifying' ? 'imageStorageMoveVerifying' : 'imageStorageMoveRemoving' : migration.status === 'interrupted' ? 'imageStorageMoveInterrupted' : 'imageStorageMoveFailed')}</strong>{moving && <ui.StateDot state="ongoing" />}</div>
            {migration.status !== 'completed' && <><code className="vc-image-storage-path">{migration.targetDirectory}</code><progress className="vc-image-storage-meter" max={Math.max(1, migration.totalBytes * 3)} value={migration.copiedBytes + migration.verifiedBytes + migration.removedBytes} aria-label={t('imageStorageMoveProgress')} /><span>{t('imageStorageMoveCounts').replace('{done}', String(migration.phase === 'removing-source' ? migration.removedFiles : migration.phase === 'verifying' ? migration.verifiedFiles : migration.copiedFiles)).replace('{total}', String(migration.totalFiles))} · {size(migration.totalBytes)}</span><p>{t('imageStorageMoveBackground')}</p></>}
            {migration.status !== 'completed' && !moving && <><p>{migration.errorCode ? failureText({ code: migration.errorCode, stage: 'storage-migration' }, 'imageStorageMoveError') : t('imageStorageMoveError')}</p><ui.Button variant="outline" disabled={busy !== null} onClick={() => { void move(true) }}>{t('imageStorageResumeMove')}</ui.Button></>}
          </div>}
        </section><section className="vc-image-storage-usage" aria-label={t('imageStorageUsed')}>
          <div className="vc-image-storage-usage-heading"><span>{t('imageStorageUsed')}</span><span>{t('imageStoragePercent').replace('{percent}', String(Math.min(100, Math.round(view.usedBytes / view.limitBytes * 100))))}</span></div>
          <div className="vc-image-storage-total"><strong>{size(view.usedBytes)}</strong><span>/ {size(view.limitBytes)}</span></div>
          <progress className="vc-image-storage-meter" value={view.usedBytes} max={Math.max(view.usedBytes, view.limitBytes)} aria-label={t('imageStorageUsed')} />
          <p className="vc-image-storage-remaining">{t('imageStorageRemaining')} <span>{size(Math.max(0, view.limitBytes - view.usedBytes))}</span></p>
        </section>
          <dl className="vc-image-storage-metrics"><div><dt>{t('imageStorageRetained')}</dt><dd>{size(view.retainedBytes)}</dd></div><div><dt>{t('imageStorageReclaimable')}</dt><dd>{size(view.reclaimableBytes)}</dd><small>{t('imageStorageFiles').replace('{count}', String(view.reclaimableFiles))}</small></div></dl>
          <p className="vc-image-storage-hint">{t('imageStorageHint')}</p>
          {!view.cleanupAllowed && !unresolved && <p className="vc-notice" role="status">{t('imageStorageBusy')}</p>}
          {!view.reclaimableFiles && <p className="vc-image-storage-empty">{t('imageStorageNothingToClean')}</p>}
          {confirming && <div className="vc-image-storage-confirm" role="alert">{t('imageStorageConfirmHint').replace('{count}', String(view.reclaimableFiles)).replace('{size}', size(view.reclaimableBytes))}</div>}
          <section className="vc-image-storage-limit"><div className="vc-image-storage-limit-heading"><label htmlFor={id}>{t('imageStorageLimit')}</label><p>{t('imageStorageLimitHint')}</p></div><div className="vc-image-storage-limit-controls"><div className="vc-image-storage-input"><ui.Input id={id} type="number" min="0" step="any" value={limit} disabled={busy !== null || confirming} onChange={event => setLimit(event.currentTarget.value)} /><span>GiB</span></div><ui.Button variant="outline" disabled={busy !== null || confirming || !view.cleanupAllowed || !Number.isSafeInteger(nextLimit) || nextLimit <= 0 || nextLimit < view.usedBytes || nextLimit <= view.limitBytes || !!error} onClick={() => { void saveLimit() }}>{t('imageStorageSaveLimit')}</ui.Button></div></section>
        </> : busy === 'read' && <div className="vc-image-storage-loading" role="status"><ui.StateDot state="ongoing" />{t('imageStorageLoading')}</div>}
        {notice && <p className="vc-image-storage-result" role="status">{notice}</p>}
        {error && <p className="vc-notice" role="alert">{error}</p>}
      </div>
    </ui.Modal>
  }
}
