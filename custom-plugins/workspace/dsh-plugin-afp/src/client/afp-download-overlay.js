const active = record => ['queued', 'running'].includes(record.status)

/** Show profile download feedback in the shell, independently of workbench mounting.
 * @param {object} React Client React runtime.
 * @param {object} UI Project feedback and dismissal primitives.
 * @param {object} icons Project download and close glyphs.
 * @param {Function} t Locale lookup.
 * @param {object} store Profile-local download state.
 * @param {Function} [openTasks] Opens the existing AFP tasks panel when its entry is enabled.
 * @returns {Function} Collapsed edge control, progress card and submission toast.
 */
export function createAfpDownloadOverlay(React, UI, icons, t, store, openTasks = () => store.selectTab('tasks')) {
  const h = React.createElement, { Button, Tag, Toast, StateDot, Tooltip, Menu, useDismissOnOutsidePointer } = UI
  const icon = (name, size = 16) => icons[name] ? h(icons[name], { size }) : null
  return function DownloadOverlay() {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    const root = React.useRef(null), trigger = React.useRef(null), card = React.useRef(null), id = React.useId()
    const open = state.downloadDockOpen
    const [menuOpen, setMenuOpen] = React.useState(false)
    const setOpen = value => store.set({ downloadDockOpen: value })
    useDismissOnOutsidePointer(root, open, setOpen)
    React.useEffect(() => { if (open) card.current?.focus({ preventScroll: true }) }, [open])
    const records = [...(state.status?.downloads ?? [])]
    const accepted = state.downloadResult
    // 提交已被 Host 接收时先显示排队状态，等待轮询返回持久化记录。
    if (accepted && !records.some(record => record.id === accepted.downloadId)) records.push({
      id: accepted.downloadId, taskId: accepted.taskId, status: 'queued', total: accepted.total,
      completed: 0, failed: 0, pending: 0, cancelled: 0, updatedAt: Date.now(), items: [],
    })
    records.sort((a, b) => Number(active(b)) - Number(active(a)) || b.updatedAt - a.updatedAt)
    const notice = state.downloadNotice, running = records.filter(active).length
    if (!records.length && !notice) return null
    const toast = notice ? h(Toast, { key: notice.id,
      text: notice.kind === 'started' ? t('downloadStartedNotice').replace('{count}', String(notice.total)) : t('downloadCancelFailed'),
      tone: notice.kind === 'started' ? 'success' : undefined,
      actions: notice.kind === 'started' ? [{ prefix: ' · ', label: t('viewDownloadProgress'), onClick: () => setOpen(true) }] : [],
      onDone: () => store.dismissDownloadNotice(notice.id),
    }) : null
    const openMenu = () => { setOpen(false); setMenuOpen(true) }
    const edge = h(Button, { ref: trigger, className: 'afp-download-edge', variant: 'outline',
      'aria-label': t('viewDownloadProgress'), 'aria-expanded': open || menuOpen, 'aria-controls': menuOpen ? undefined : id,
      'aria-haspopup': 'menu', onClick: () => { setMenuOpen(false); setOpen(!open) },
      onContextMenu: event => { event.preventDefault(); event.stopPropagation(); openMenu() },
      onKeyDown: event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); event.stopPropagation(); openMenu() } } },
      h('svg', { className: 'afp-download-glyph' + (running ? ' is-running' : ''), width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { className: 'afp-download-glyph-arrow', d: 'M12 3v11m-4-4 4 4 4-4' }),
        h('path', { className: 'afp-download-glyph-tray', d: 'M4 16v4h16v-4' })),
      h('span', null, String(running || records.length)))
    const edgeControl = h(Menu, { open: menuOpen, anchor: edge, portal: true, compact: true, autoFocus: true, side: 'top', align: 'end',
      getAnchorRect: () => trigger.current?.getBoundingClientRect() ?? null,
      onClose: () => setMenuOpen(false), items: [
        { id: 'progress', label: t('viewDownloadProgress'), icon: icon('IconDownloadOutlineRegular') },
        { id: 'tasks', label: t('openDownloadTasks'), icon: icon('IconFlatListOutlineRegular'), disabled: !state.status?.features?.includes('ui-panel') },
      ], onSelect: value => {
        setMenuOpen(false)
        if (value === 'progress') setOpen(true)
        if (value === 'tasks' && state.status?.features?.includes('ui-panel')) { setOpen(false); openTasks() }
      } })
    return h('div', { ref: root, className: 'afp-download-overlay' + (open ? ' is-open' : ''),
      onKeyDown: event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() } } },
    toast, records.length ? h(React.Fragment, null,
      h('div', { className: 'afp-download-edge-shell' },
        Tooltip ? h(Tooltip, { label: t('viewDownloadProgress'), side: 'top', align: 'end', maxWidth: 180, disabled: menuOpen || open, portal: true }, edgeControl) : edgeControl),
      h('aside', { id, ref: card, tabIndex: -1, className: 'afp-download-card', inert: open ? undefined : '', 'aria-hidden': !open, 'aria-label': t('downloadProgressTitle') },
        h('header', null, h('h2', null, t('downloadProgressTitle')), running ? h(Tag, { tone: 'info' }, String(running)) : null,
          h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-close-button', 'aria-label': t('collapseDownloadProgress'), onClick: () => { setOpen(false); trigger.current?.focus() } }, icon('IconCloseOutlineRegular', 14))),
        h('div', { className: 'afp-download-records' }, ...records.map(record => {
          const processed = Math.min(record.total, (record.completed ?? 0) + (record.failed ?? 0) + (record.pending ?? 0) + (record.cancelled ?? 0))
          const live = active(record) && record.taskId && (record.taskId === accepted?.taskId || state.status?.tasks?.some(task => task.taskId === record.taskId))
          const cancelling = state.downloadCancellingId === record.taskId
          const latest = record.items?.find(item => item.status === 'running') ?? record.items?.findLast(item => item.status === 'completed') ?? record.items?.[0]
          return h('article', { key: record.id, className: 'afp-download-record' },
            h('div', { className: 'afp-download-record-heading' }, active(record) ? h(StateDot, { state: 'ongoing', size: 14 }) : null,
              h('span', null, t('photoCountShort').replace('{count}', String(record.total))),
              h(Tag, { tone: record.status === 'completed' ? 'success' : ['partial', 'failed', 'interrupted'].includes(record.status) ? 'warning' : 'quiet' }, t(`downloadStatus_${record.status}`))),
            latest ? h('p', { className: 'afp-download-file', title: latest.fileName || latest.title }, latest.fileName || latest.title) : null,
            h('progress', { max: Math.max(1, record.total), value: processed, 'aria-label': t('downloadProcessed').replace('{count}', String(processed)).replace('{total}', String(record.total)) }),
            h('div', { className: 'afp-download-record-footer' }, h('span', null, `${processed}/${record.total} · ${t('failedCount')} ${record.failed ?? 0}`),
              live ? h(Button, { variant: 'ghost', size: 'sm', 'data-download-cancel': true, disabled: state.busy, 'aria-busy': cancelling,
                icon: cancelling ? h(StateDot, { state: 'ongoing', size: 14 }) : null,
                onClick: () => { void store.cancelDownload(record.taskId) } }, t('cancel')) : null))
        })))) : null)
  }
}
