/** Archive management reads metadata without retaining or activating cold sessions. */
import { useId, useState } from 'react'
import {
  AnimatedCollapse, Button, Checkbox, Input, Menu, Modal, SegmentedTabs, StateDot, Tag, Tooltip,
  IconArchiveOutlineRegular, IconUnarchiveOutlineRegular, IconSearchOutlineRegular,
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconFolderCloseRegular,
  IconPinOutlineRegular, IconPinFillRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import type { ArchivePageProps } from './contract.ts'
import type { ArchiveKey } from './locales.ts'
import { matchesDates, presetDates, sortSessions, type ArchiveDates } from './view.ts'
import artwork from './assets/archive-whale-maid-v1.webp'
import css from './ArchivePage.module.css'

function FilterMenu({ label, value, items, onChange }: {
  label: string
  value: string
  items: readonly { id: string; label: string }[]
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = items.find(item => item.id === value)?.label ?? label
  return <Menu open={open} portal autoFocus selectedId={value} items={items} onClose={() => { setOpen(false) }}
    onSelect={(id) => { setOpen(false); onChange(id) }} anchor={<Button variant="ghost" className={css.filter}
      aria-label={`${label}: ${selected}`} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }}>
      <span>{selected}</span><IconChevronDownOutlineRegular size={14} /></Button>} />
}

type RowProps = Pick<ArchivePageProps, 't' | 'useSessionAccess' | 'run' | 'favorite' | 'open'> & {
  row: SessionSummary
  archived: boolean
  favorited: boolean
  status: SessionStatus | undefined
  selected: boolean
  busy: boolean
  favoritesWritable: boolean
  onSelect: (checked: boolean) => void
  onDelete: () => void
}

function SessionRow({ row, archived, favorited, status, selected, busy, favoritesWritable,
  onSelect, onDelete, useSessionAccess, run, favorite, open, t }: RowProps) {
  const allowed = useSessionAccess(row.id, archived ? 'workspace/unarchiveSession' : 'workspace/archiveSession')
  const deleteAllowed = useSessionAccess(row.id, 'sessionDeletion/deleteSession')
  const readAllowed = useSessionAccess(row.id, 'session/follow')
  const title = row.title?.trim() || t('untitled')
  const running = status?.running ?? row.running
  const waiting = status?.pendingInteraction !== undefined
  const blocked = !archived && (running || waiting)
  const favoriteLabel = t(favorited ? 'unfavorite' : 'favorite', { title })
  const updated = row.updatedAt > 0 && Number.isFinite(row.updatedAt)
    ? t('updated', { date: new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(row.updatedAt) })
    : t('unknownDate')
  return <li className={css.row} data-archive-row={row.id} data-selected={selected}>
    <Checkbox className={css.rowCheckbox} label={t('selectSession', { title })} checked={selected}
      disabled={busy || !allowed || blocked} onChange={onSelect} />
    <div className={css.rowMain}>
      <button type="button" className={css.sessionTitle} disabled={busy || !readAllowed || (archived && !allowed)}
        aria-label={`${t(archived ? 'restoreOpen' : 'open')} · ${title}`}
        onClick={() => { if (archived) void run('restore', [row.id], row.id); else open(row.id) }}>{title}</button>
      <div className={css.rowMeta}><span>{updated}</span>
        {running ? <Tag tone="info">{t('running')}</Tag> : waiting ? <Tag tone="warning">{t('waiting')}</Tag> : null}</div>
    </div>
    <div className={css.rowActions}>
      <Tooltip label={favoriteLabel} portal><Button variant="ghost" size="sm" disabled={busy || !favoritesWritable} aria-label={favoriteLabel} aria-pressed={favorited}
        icon={favorited ? <IconPinFillRegular size={16} /> : <IconPinOutlineRegular size={16} />}
        onClick={() => { void favorite(row.id, !favorited) }} /></Tooltip>
      <Button variant="ghost" size="sm" disabled={busy || !allowed || blocked}
        aria-label={t(archived ? 'restore' : 'archive')}
        icon={archived ? <IconUnarchiveOutlineRegular size={16} /> : <IconArchiveOutlineRegular size={16} />}
        onClick={() => { void run(archived ? 'restore' : 'archive', [row.id]) }}>{t(archived ? 'restore' : 'archive')}</Button>
      {archived && <Button variant="outline" size="sm" className={css.openAction} disabled={busy || !allowed || !readAllowed}
        onClick={() => { void run('restore', [row.id], row.id) }}>{t('restoreOpen')}<IconChevronRightOutlineRegular size={12} /></Button>}
      {archived && <Tooltip label={t('deleteSession', { title })} portal><Button variant="ghost" size="sm" className={css.danger}
        disabled={busy || !deleteAllowed || running || waiting} aria-label={t('deleteSession', { title })}
        icon={<IconTrashOutlineRegular size={16} />} onClick={onDelete} /></Tooltip>}
    </div>
  </li>
}

/** @param props - framework metadata hooks, localized copy and narrow archive callbacks. @returns the settings page and date editor. */
export function ArchivePage(props: ArchivePageProps) {
  const { useSessions, useWorkspaces, useSessionStatus, useOperation, run, retry, refresh, canChange, dismissResult, t } = props
  const sessions = useSessions(value => value)
  const workspaces = useWorkspaces(value => value)
  const statuses = useSessionStatus(value => value)
  const operation = useOperation(value => value)
  const favorites = props.useFavorites(value => value)
  const [tab, setTab] = useState<'archived' | 'unarchived'>('archived')
  const [query, setQuery] = useState('')
  const [workspace, setWorkspace] = useState('all')
  const [favoritesOnly, setPinnedOnly] = useState(false)
  const [sort, setSort] = useState('newest')
  const [datePreset, setDatePreset] = useState('all')
  const [dates, setDates] = useState<ArchiveDates>({ from: '', to: '' })
  const [dateDraft, setDateDraft] = useState<ArchiveDates | null>(null)
  const [selection, setSelection] = useState<readonly SessionId[]>([])
  const [deleteTargets, setDeleteTargets] = useState<readonly SessionSummary[] | null>(null)
  const [collapsed, setCollapsed] = useState<readonly string[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const id = useId()
  const archived = tab === 'archived'
  const archivedIds = new Set(workspaces.archivedSessionIds)
  const favoriteIds = new Set(favorites.value?.favoriteSessionIds ?? [])
  const favoritesWritable = favorites.status === 'ready' && favorites.writable
  const membership = new Map<SessionId, string>()
  for (const item of workspaces.items) for (const sessionId of item.sessionIds) {
    if (workspace === item.workspaceId || !membership.has(sessionId)) membership.set(sessionId, item.workspaceId)
  }
  const catalog = sessions.ids.map(sessionId => sessions.byId[sessionId])
    .filter((row): row is SessionSummary => row !== undefined && row.origin !== 'subagent' && !row.blank)
  const scope = catalog.filter(row => archivedIds.has(row.id) === archived)
  const rows = sortSessions(scope.filter(row => (workspace === 'all' || (membership.get(row.id) ?? 'ungrouped') === workspace)
    && (!favoritesOnly || favoriteIds.has(row.id)) && matchesDates(row.updatedAt, dates)
    && (row.title?.trim() || t('untitled')).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), sort)
  const selected = rows.filter(row => selection.includes(row.id)).map(row => row.id)
  const selectable = rows.filter(row => archived
    || !((statuses.get(row.id)?.running ?? row.running) || statuses.get(row.id)?.pendingInteraction !== undefined))
  const busy = operation.progress !== null
  const loading = sessions.phase === 'pending' || workspaces.phase === 'pending'
  const failed = refreshFailed || workspaces.state === 'error'
  const hasFilters = query !== '' || workspace !== 'all' || favoritesOnly || dates.from !== '' || dates.to !== ''
  const groups = [
    ...workspaces.items.map(item => ({ id: item.workspaceId, title: item.title, path: item.path })),
    { id: 'ungrouped', title: t('ungrouped'), path: '' },
  ].map(group => ({ ...group, rows: rows.filter(row => (membership.get(row.id) ?? 'ungrouped') === group.id) })).filter(group => group.rows.length > 0)
  const dateKeys: Readonly<Record<string, ArchiveKey>> = { all: 'allTime', week: 'lastWeek', month: 'lastMonth', older: 'olderMonth', custom: 'customDate' }
  const dateLabel = datePreset === 'custom' ? `${dates.from || '…'} – ${dates.to || '…'}` : t(dateKeys[datePreset] ?? 'allTime')
  const clearSelection = (): void => { setSelection([]) }
  const reset = (): void => {
    setQuery(''); setWorkspace('all'); setPinnedOnly(false); setDates({ from: '', to: '' }); setDatePreset('all'); clearSelection()
  }
  const refreshList = (): void => {
    if (refreshing) return
    setRefreshing(true); setRefreshFailed(false)
    void refresh().catch(() => { setRefreshFailed(true) }).finally(() => { setRefreshing(false) })
  }
  const select = (sessionId: SessionId, checked: boolean): void => {
    setSelection(current => checked
      ? [...current.filter(value => value !== sessionId), sessionId] : current.filter(value => value !== sessionId))
  }
  return <div className={css.page} data-archive-settings>
    <header data-settings-page-header><h1>{t('title')}</h1></header>
    <div className={css.intro}>
      <img src={artwork} width={104} height={104} alt="" aria-hidden="true" draggable={false} decoding="async" />
      <div className={css.introCopy}><h2>{t('introTitle')}</h2><p>{t('intro')}</p></div>
      <Button variant="outline" disabled={refreshing || busy} aria-busy={refreshing} onClick={refreshList}>{t('refresh')}</Button>
    </div>
    <SegmentedTabs className={css.tabs} variant="underline" label={t('tabs')} value={tab}
      onChange={(value) => { setTab(value); clearSelection() }} items={[
        { value: 'archived', label: <>{t('archived')}<span className={css.tabCount}>{catalog.filter(row => archivedIds.has(row.id)).length}</span></>, id: `${id}-archived`, panelId: `${id}-panel` },
        { value: 'unarchived', label: <>{t('unarchived')}<span className={css.tabCount}>{catalog.filter(row => !archivedIds.has(row.id)).length}</span></>, id: `${id}-unarchived`, panelId: `${id}-panel` },
      ]} />
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className={css.panel}>
      <div className={css.toolbar}>
        <Input className={css.search as string} icon={<IconSearchOutlineRegular size={16} />} type="search" aria-label={t('search')}
          placeholder={t('search')} value={query} onChange={(event) => { setQuery(event.target.value); clearSelection() }} />
        <div className={css.filters}>
          <FilterMenu label={t('workspace')} value={workspace} items={[
            { id: 'all', label: t('allWorkspaces') }, ...workspaces.items.map(item => ({ id: item.workspaceId, label: item.title })),
            { id: 'ungrouped', label: t('ungrouped') },
          ]} onChange={(value) => { setWorkspace(value); clearSelection() }} />
          <FilterMenu label={t('date')} value={datePreset} items={Object.entries(dateKeys).map(([key, copy]) => ({ id: key, label: t(copy) }))}
            onChange={(value) => {
              if (value === 'custom') { setDateDraft(dates); return }
              setDatePreset(value); setDates(presetDates(value, new Date())); clearSelection()
            }} />
          <FilterMenu label={t('sort')} value={sort} items={[
            { id: 'newest', label: t('newest') }, { id: 'oldest', label: t('oldest') }, { id: 'title', label: t('alphabetical') },
          ]} onChange={setSort} />
          <Button variant={favoritesOnly ? 'outline' : 'ghost'} className={css.pinFilter} aria-pressed={favoritesOnly} disabled={favorites.value === undefined}
            icon={<IconPinOutlineRegular size={14} />} onClick={() => { setPinnedOnly(!favoritesOnly); clearSelection() }}>{t('favoritesOnly')}</Button>
        </div>
      </div>
      {datePreset === 'custom' && <div className={css.customRange}><span>{t('date')}: {dateLabel}</span><Button size="sm" variant="ghost"
        onClick={() => { setDateDraft(dates) }}>{t('customDate')}</Button></div>}
      <div className={css.selectionBar}>
        <Checkbox label={t('selectAll')} checked={selectable.length > 0 && selectable.every(row => selected.includes(row.id))}
          disabled={busy || selectable.length === 0} onChange={(checked) => {
            setSelection(checked ? selectable.filter(row => canChange(row.id, archived)).map(row => row.id) : [])
          }} />
        <span className={css.count} role="status">{operation.progress !== null
          ? t('progress', { done: operation.progress.done, total: operation.progress.total })
          : selected.length > 0 ? t('selected', { count: selected.length }) : t('count', { count: rows.length })}</span>
        <div className={css.bulkActions}>
          {selected.length > 0 && <Button size="sm" variant="ghost" onClick={clearSelection}>{t('clearSelection')}</Button>}
          {archived && <Button size="sm" variant="ghost" className={css.danger}
            disabled={busy || selected.length === 0 || selected.some(sessionId => !props.canDelete(sessionId))}
            icon={<IconTrashOutlineRegular size={14} />} onClick={() => { setDeleteTargets(rows.filter(row => selected.includes(row.id))) }}>{t('deleteSelected')}</Button>}
          <Button size="sm" variant={selected.length > 0 ? 'primary' : 'outline'} disabled={busy || selected.length === 0}
            icon={archived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} />}
            onClick={() => { void run(archived ? 'restore' : 'archive', selected); clearSelection() }}>{t(archived ? 'restoreSelected' : 'archiveSelected')}</Button>
        </div>
      </div>
      {failed && <div className={css.error} role="alert"><span>{t('loadError')}</span><Button variant="ghost" size="sm" disabled={refreshing} onClick={refreshList}>{t('retry')}</Button></div>}
      {operation.result !== null && <section className={css.failures} aria-label={t('retryFailed')}>
        <div className={css.failureHeader}><span>{t('partial', { success: operation.result.success, failed: operation.result.failures.length })}</span>
          <div><Button size="sm" variant="outline" disabled={busy} onClick={() => { void retry() }}>{t('retryFailed')}</Button>
            <Button size="sm" variant="ghost" onClick={dismissResult}>{t('close')}</Button></div></div>
        <ul>{operation.result.failures.map(item => <li key={item.id}><strong>{item.title}</strong><span>{t(item.reason)}</span></li>)}</ul>
      </section>}
      {loading && !failed ? <div className={css.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" size={24} /></div>
        : rows.length === 0 ? <div className={css.empty}>
          <IconArchiveOutlineRegular size={32} />
          <h2>{t(hasFilters ? 'noResults' : archived ? 'emptyArchived' : 'emptyUnarchived')}</h2>
          <p>{t(hasFilters ? 'noResultsHint' : archived ? 'emptyArchivedHint' : 'emptyUnarchivedHint')}</p>
          {hasFilters ? <Button variant="outline" onClick={reset}>{t('resetFilters')}</Button>
            : archived && <Button variant="outline" onClick={() => { setTab('unarchived'); clearSelection() }}>{t('unarchived')}</Button>}
        </div> : <div className={css.groups}>{groups.map((group) => {
          const closed = collapsed.includes(group.id)
          return <section key={group.id} className={css.group}>
            <Tooltip label={group.path} disabled={group.path === ''} portal side="top">
              <button type="button" className={css.groupHeader} aria-expanded={!closed} aria-controls={`${id}-group-${group.id}`}
                aria-label={t('groupToggle', { name: group.title })}
                aria-describedby={group.path === '' ? undefined : `${id}-path-${group.id}`} onClick={() => {
                  setCollapsed(current => closed ? current.filter(value => value !== group.id) : [...current, group.id])
                }}><span className={css.folderMark}><IconFolderCloseRegular size={16} /></span>
                <span className={css.groupIdentity}><span className={css.groupTitle}>{group.title}</span>
                  {group.path !== '' && <span id={`${id}-path-${group.id}`} className={css.groupPath}>{group.path}</span>}</span>
                <span className={css.groupCount}>{t('groupCount', { count: group.rows.length })}</span>
                <IconChevronDownOutlineRegular size={14} />
              </button>
            </Tooltip>
            <AnimatedCollapse id={`${id}-group-${group.id}`} open={!closed}>
              <ul className={css.rows}>
                {group.rows.map(row => <SessionRow key={row.id} row={row} archived={archived}
                  favorited={favoriteIds.has(row.id)} status={statuses.get(row.id)}
                  selected={selected.includes(row.id)} busy={busy} favoritesWritable={favoritesWritable}
                  onSelect={(checked) => { select(row.id, checked) }}
                  onDelete={() => { setDeleteTargets([row]) }}
                  useSessionAccess={props.useSessionAccess} run={(operation, ids, openAfter) => {
                    setSelection(current => current.filter(value => !ids.includes(value)))
                    return run(operation, ids, openAfter)
                  }} favorite={props.favorite} open={props.open} t={t} />)}
              </ul>
            </AnimatedCollapse>
          </section>
        })}</div>}
      <p className={css.footnote}>{t(archived ? 'restoreOpenHint' : 'archiveHint')}</p>
    </div>
    {deleteTargets !== null && <Modal open title={t('deleteConfirmTitle')} closeLabel={t('close')}
      description={deleteTargets.length === 1 ? t('deleteDescription', { title: deleteTargets[0]?.title?.trim() || t('untitled') })
        : t('deleteManyDescription', { count: deleteTargets.length })}
      onClose={() => { if (!busy) setDeleteTargets(null) }}
      footer={<><Button variant="outline" disabled={busy} onClick={() => { setDeleteTargets(null) }}>{t('cancel')}</Button>
        <Button variant="outline" className={css.danger} disabled={busy} aria-busy={busy}
          icon={<IconTrashOutlineRegular size={16} />} onClick={() => {
            clearSelection()
            void run('delete', deleteTargets.map(row => row.id)).finally(() => { setDeleteTargets(null) })
          }}>{t(busy ? 'deleting' : 'deleteConfirm')}</Button></>}>
      {operation.progress !== null && <div className={css.deleteProgress}>
        <div className={css.deleteProgressLabel} role="status" aria-live="polite">
          <StateDot state="ongoing" size={16} />
          <span>{t('deleteProgress', operation.progress)}</span>
        </div>
        <div className={css.deleteProgressTrack} role="progressbar" aria-label={t('deleting')}
          aria-valuemin={0} aria-valuemax={operation.progress.total} aria-valuenow={operation.progress.done}>
          <div className={css.deleteProgressFill} style={{ width: `${operation.progress.done / operation.progress.total * 100}%` }} />
        </div>
      </div>}
    </Modal>}
    {dateDraft !== null && <Modal open title={t('customDate')} description={t('dateHint')} closeLabel={t('close')} onClose={() => { setDateDraft(null) }}
      footer={<><Button variant="outline" onClick={() => { setDateDraft(null) }}>{t('cancel')}</Button><Button variant="primary"
        disabled={dateDraft.from !== '' && dateDraft.to !== '' && dateDraft.from > dateDraft.to}
        onClick={() => { setDates(dateDraft); setDatePreset(dateDraft.from === '' && dateDraft.to === '' ? 'all' : 'custom'); setDateDraft(null); clearSelection() }}>{t('apply')}</Button></>}>
      <div className={css.dateFields}><label>{t('from')}<Input type="date" aria-label={t('from')} value={dateDraft.from}
        onChange={(event) => { setDateDraft({ ...dateDraft, from: event.target.value }) }} /></label>
      <label>{t('to')}<Input type="date" aria-label={t('to')} value={dateDraft.to}
        onChange={(event) => { setDateDraft({ ...dateDraft, to: event.target.value }) }} /></label></div>
      {dateDraft.from !== '' && dateDraft.to !== '' && dateDraft.from > dateDraft.to && <p className={css.error} role="alert">{t('invalidDate')}</p>}
    </Modal>}
  </div>
}
