/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Select pictures from the server rating window without changing their server records. */
import { groupServerReferences, serverReferenceCatalogSchema, serverReferenceCredential, serverReferenceReceiptSchema, type ServerReferenceCatalog, type ServerReferenceKey, type ServerReferenceReceipt } from '../shared/server-references.ts'
import type { StyleView } from './contract.ts'
import { createGalleryMedia, galleryImageSource } from './gallery-media.tsx'
import { createReferencePreview } from './reference-preview.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import type { WorkbenchProps } from './workbench.tsx'

interface Props {
  style: StyleView
  role: 'positive' | 'negative'
  onRole(role: 'positive' | 'negative'): void
  pageSize: number
  maxFiles: number
  actions: Pick<WorkbenchProps['actions'], 'serverReference' | 'saveCredential' | 'reload'>
  t: WorkbenchText
  onClose(): void
}

/** @param React Shared runtime. @param ui Workbench controls. @returns The grouped server reference picker. */
export function createServerReferenceDialog(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const ReferencePreview = createReferencePreview(React, ui)
  const { GallerySkeleton, GalleryLoadMore } = createGalleryMedia(React, ui)
  const code = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return function ServerReferenceDialog({ style, role, onRole, pageSize, maxFiles, actions, t, onClose }: Props) {
    const [catalog, setCatalog] = React.useState<ServerReferenceCatalog | null>(null)
    const [grade, setGrade] = React.useState<string | null | undefined>(undefined)
    const [selected, setSelected] = React.useState<Set<ServerReferenceKey>>(new Set())
    const [visible, setVisible] = React.useState(pageSize)
    const [reading, setReading] = React.useState(true)
    const [saving, setSaving] = React.useState(false)
    const [problem, setProblem] = React.useState<'' | 'serverReferenceAuth' | 'serverReferenceReadError' | 'serverReferenceLimit' | 'serverReferenceImportError' | 'serverReferenceRefresh'>('')
    const [token, setToken] = React.useState('')
    const [receipt, setReceipt] = React.useState<ServerReferenceReceipt['results']>([])
    const lifetime = React.useRef<AbortController | null>(null)
    const resultsRoot = React.useRef<HTMLDivElement>(null)
    const tokenId = React.useId()
    const groups = React.useMemo(() => groupServerReferences(catalog?.items ?? []), [catalog])
    const currentGroups = grade === undefined ? groups : groups.filter(group => group.grade === grade)
    const matches = currentGroups.reduce((total, group) => total + group.items.length, 0)
    const busy = reading || saving
    const label = (value: string | null) => value ?? t('serverReferenceUnrated')
    const setFilter = (value: string | null | undefined) => {
      setGrade(value)
      setVisible(pageSize)
      if (resultsRoot.current) resultsRoot.current.scrollTop = 0
    }

    const load = React.useCallback(async (signal: AbortSignal) => {
      setReading(true); setProblem('')
      try {
        const next = serverReferenceCatalogSchema.parse(await actions.serverReference('server-reference-list', {}, signal))
        if (signal.aborted) return
        setCatalog(next)
        const available = new Set(next.items.map(image => image.key))
        setSelected(previous => new Set([...previous].filter(key => available.has(key))))
        setGrade(previous => next.items.some(image => image.grade === previous) ? previous : undefined)
        setVisible(pageSize)
      } catch (error) {
        if (!signal.aborted) setProblem(code(error) === 'configuration-required' ? 'serverReferenceAuth' : code(error) === 'budget-exhausted' ? 'serverReferenceLimit' : 'serverReferenceReadError')
      } finally { if (!signal.aborted) setReading(false) }
    }, [actions, pageSize])
    React.useEffect(() => {
      const controller = new AbortController()
      lifetime.current = controller
      void load(controller.signal)
      return () => { controller.abort(); lifetime.current = null }
    }, [load])

    const connect = async () => {
      const signal = lifetime.current?.signal
      if (!signal || !token.trim() || busy) return
      setSaving(true)
      try {
        await actions.saveCredential(serverReferenceCredential, token.trim())
        if (signal.aborted) return
        setToken('')
        await load(signal)
      } catch (error) { if (!signal.aborted) setProblem('serverReferenceAuth') }
      finally { if (!signal.aborted) setSaving(false) }
    }
    const submit = async () => {
      const signal = lifetime.current?.signal
      if (!signal || !catalog || !selected.size || busy) return
      const keys = [...selected]
      setSaving(true); setProblem(''); setReceipt([])
      try {
        const result = serverReferenceReceiptSchema.parse(await actions.serverReference('server-reference-import', {
          snapshotId: catalog.snapshotId, keys, styleId: style.styleId, expectedRevision: style.revision, role, operationId: crypto.randomUUID(),
        }, signal))
        if (result.results.length !== keys.length || result.results.some((item, index) => item.key !== keys[index])) throw new Error('server-reference-receipt-mismatch')
        if (signal.aborted) return
        setReceipt(result.results)
        setSelected(new Set(result.results.filter(item => item.status === 'failed').map(item => item.key)))
        if (result.results.some(item => item.status === 'added')) await actions.reload()
      } catch (error) {
        if (signal.aborted) return
        setProblem(code(error) === 'reference-unavailable' ? 'serverReferenceRefresh' : 'serverReferenceImportError')
        await actions.reload()
      } finally { if (!signal.aborted) setSaving(false) }
    }
    const toggle = (key: ServerReferenceKey, checked: boolean) => {
      setSelected(previous => {
        if (checked && previous.size >= maxFiles) return previous
        const next = new Set(previous)
        if (checked) next.add(key)
        else next.delete(key)
        return next
      })
    }
    const close = () => { if (!saving) onClose() }
    const counts = { added: 0, skipped: 0, failed: 0 }
    const failures = new Map<ServerReferenceKey, string | undefined>()
    for (const row of receipt) {
      counts[row.status]++
      if (row.status === 'failed') failures.set(row.key, row.code)
    }
    let remaining = visible
    return <ui.Modal open onClose={close} title={t('serverReferenceTitle')} closeLabel={t('close')}
      className="vc-server-reference-modal" contentClassName="vc-server-reference-content"
      footer={<div className="vc-server-reference-footer">
        <div aria-live="polite">{t('taskReferenceSelectedImages')} <strong>{selected.size}</strong> / {maxFiles} {selected.size > 0 && <ui.Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelected(new Set())}>{t('galleryClearSelection')}</ui.Button>}</div>
        <div><ui.Button variant="outline" disabled={saving} onClick={close}>{t('close')}</ui.Button>
          <ui.Button variant="primary" disabled={busy || !selected.size || problem === 'serverReferenceAuth' || problem === 'serverReferenceRefresh'} onClick={() => { void submit() }}>{t(saving ? 'taskReferenceSubmitting' : role === 'positive' ? 'taskReferenceAddPositive' : 'taskReferenceAddNegative')}</ui.Button>
        </div>
      </div>}>
      {problem === 'serverReferenceAuth' && <form className="vc-server-reference-connect" onSubmit={event => { event.preventDefault(); void connect() }}>
        <p role="alert">{t(problem)}</p>
        <label htmlFor={tokenId}>{t('serverToken')}</label>
        <ui.Input id={tokenId} type="password" autoComplete="new-password" spellCheck={false} value={token} disabled={busy} onChange={event => setToken(event.currentTarget.value)} />
        <ui.Button variant="primary" type="submit" disabled={!token.trim() || busy}>{t('serverReferenceConnect')}</ui.Button>
      </form>}
      {catalog && problem !== 'serverReferenceAuth' && <div className="vc-task-reference-toolbar">
        <div className="vc-task-reference-toolbar-heading">
          <div><h3>{style.name}</h3><p>{catalog.startDate} – {catalog.endDate}</p></div>
          <div className="vc-task-reference-role" role="group" aria-label={t('role')}>
            <span>{t('role')}</span>
            {(['positive', 'negative'] as const).map(value => <ui.Button key={value} size="sm" variant="ghost" disabled={busy} aria-pressed={role === value} onClick={() => onRole(value)}>{t(value)}</ui.Button>)}
          </div>
        </div>
        <div className="vc-task-reference-filter-row">
          <div className="vc-task-reference-filters" role="group" aria-label={t('serverReferenceGrade')}>
            <ui.Button size="sm" variant="ghost" disabled={busy} aria-pressed={grade === undefined} onClick={() => setFilter(undefined)}>{t('all')} · {catalog.items.length}</ui.Button>
            {groups.map(group => <ui.Button key={group.grade ?? ''} size="sm" variant="ghost" disabled={busy} aria-pressed={grade === group.grade} onClick={() => setFilter(group.grade)}>{label(group.grade)} · {group.items.length}</ui.Button>)}
          </div>
          <ui.Button size="sm" variant="ghost" disabled={busy} onClick={() => { const signal = lifetime.current?.signal; if (signal) void load(signal) }}>{t('galleryRefresh')}</ui.Button>
        </div>
      </div>}
      {problem && problem !== 'serverReferenceAuth' && <div className="vc-task-reference-notice" role="alert">{t(problem)}{!catalog && <ui.Button size="sm" variant="outline" disabled={busy} onClick={() => { const signal = lifetime.current?.signal; if (signal) void load(signal) }}>{t('retry')}</ui.Button>}</div>}
      {!!receipt.length && <div className="vc-task-reference-notice" role="status">{t('taskReferenceAdded')} {counts.added} · {t('taskReferenceSkipped')} {counts.skipped} · {t('taskReferenceFailed')} {counts.failed}</div>}
      <div ref={resultsRoot} className="vc-task-reference-results" aria-busy={busy || undefined}>
        {reading && !catalog && <GallerySkeleton kind="photos" count={6} label={t('serverReferenceLoading')} />}
        {catalog && problem !== 'serverReferenceAuth' && <>
          {!!catalog.ignored && <p className="vc-server-reference-muted" role="status">{t('serverReferenceIgnored')} · {catalog.ignored}</p>}
          {!matches && <div className="vc-task-reference-empty"><p>{t('serverReferenceEmpty')}</p></div>}
          {currentGroups.map(group => {
            const items = group.items.slice(0, remaining)
            remaining -= items.length
            if (!items.length) return null
            return <section key={group.grade ?? ''} className="vc-server-reference-group" aria-label={label(group.grade)}>
              <h4>{label(group.grade)} <small>{group.items.length}</small></h4>
              <div className="vc-task-reference-grid">{items.map(image => {
                const name = image.name === image.itemId ? image.itemId : image.name + ' · ' + image.itemId
                const source = galleryImageSource(image.previewPath, '')
                return <figure key={image.key} data-selected={selected.has(image.key) || undefined}>
                  <div className="vc-task-reference-image">
                    <ReferencePreview key={catalog.snapshotId} src={source} href={source} alt={name} width={400} height={300} refreshKey={0} t={t} />
                    {failures.has(image.key) && <ui.Tag tone="warning">{t(failures.get(image.key) === 'constraint-conflict' ? 'serverReferenceRoleConflict' : 'taskReferenceFailed')}</ui.Tag>}
                  </div>
                  <figcaption>
                    <ui.Checkbox label={name} title={name} checked={selected.has(image.key)} disabled={busy || !selected.has(image.key) && selected.size >= maxFiles} onChange={checked => toggle(image.key, checked)} />
                    {image.score !== null && <small title={t('serverReferenceScore')}>{t('serverReferenceScore')} {image.score}</small>}
                  </figcaption>
                </figure>
              })}</div>
            </section>
          })}
          <GalleryLoadMore hasMore={visible < matches} loading={false} disabled={busy} version={visible} label={t('taskMoreResults')} kind="photos" onLoad={() => setVisible(value => value + pageSize)} />
          {visible < matches && <ui.Button className="vc-task-more" variant="outline" disabled={busy} onClick={() => setVisible(value => value + pageSize)}>{t('taskMoreResults')} · {visible} / {matches}</ui.Button>}
        </>}
      </div>
    </ui.Modal>
  }
}
