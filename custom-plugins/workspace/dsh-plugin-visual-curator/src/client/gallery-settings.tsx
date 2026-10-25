/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Account navigation, gallery folders and selected references use the shell component system. */
import type { ActionArgs, ConfigurationView, StyleView } from './contract.ts'
import type { WorkbenchProps } from './workbench.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import type { GalleryAccount, GalleryCollection, GalleryPage, GalleryPhoto, GalleryPhotoScope, GalleryLoginView } from '../shared/gallery.ts'
import { connectGalleryLogin, withGalleryAccount } from './gallery-login.ts'
import { createGalleryMedia } from './gallery-media.tsx'
import { filterGalleryPhotos, readCollectionPhotos } from './gallery-reference.ts'

interface Props {
  config: ConfigurationView; actions: WorkbenchProps['actions']; t: WorkbenchText
  styles: StyleView[]; selectedStyleId: string; saveSource(source: ConfigurationView['source']): Promise<void>
  openWorkbench(styleId: string): void
  openAdvanced(): void
}

/** @param React Shell runtime. @param ui Shared primitives. @returns Stable account-gallery settings component. */
export function createGallerySettings(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, Input, Tag, StateDot, Checkbox, Menu, Modal, SegmentedTabs } = ui
  const { GallerySkeleton, GalleryPhotoPreview, GalleryLoadMore } = createGalleryMedia(React, ui)
  return function GallerySettings({ config, actions, t, styles, selectedStyleId, saveSource, openWorkbench, openAdvanced }: Props) {
    const source = config.source, accounts = source.unsplash.accounts
    const [selectedAccount, setSelectedAccount] = React.useState<string>(source.unsplash.defaultAccountId ?? accounts[0]?.id ?? 'public')
    const [folders, setFolders] = React.useState<GalleryPage<GalleryCollection>>({ items: [], nextCursor: null })
    const [photos, setPhotos] = React.useState<GalleryPage<GalleryPhoto>>({ items: [], nextCursor: null })
    const [scope, setScope] = React.useState<GalleryPhotoScope | null>(null), [folderTitle, setFolderTitle] = React.useState('')
    const [query, setQuery] = React.useState(''), [loading, setLoading] = React.useState(false), [saving, setSaving] = React.useState(false)
    const [appending, setAppending] = React.useState(false)
    const [uncertainImport, setUncertainImport] = React.useState(false)
    const queryValue = React.useRef('')
    const collectionRead = React.useRef<AbortController | null>(null)
    const changeQuery = (value: string) => {
      queryValue.current = value; setQuery(value)
      if (!value.trim() && collectionRead.current) {
        const reading = collectionRead.current; collectionRead.current = null; reading.abort()
        if (request.current === reading) { ++sequence.current; setLoading(false) }
      }
    }
    const [collectionFilter, setCollectionFilter] = React.useState(''), [photoPage, setPhotoPage] = React.useState(0)
    const [error, setError] = React.useState(''), [status, setStatus] = React.useState<Record<string, 'ready' | 'error'>>({})
    const [selected, setSelected] = React.useState<string[]>([]), [targetStyle, setTargetStyle] = React.useState(selectedStyleId), [styleMenu, setStyleMenu] = React.useState(false)
    const [accountMenu, setAccountMenu] = React.useState(false), [accountActions, setAccountActions] = React.useState(false)
    const [dataKey, setDataKey] = React.useState('')
    const galleryId = React.useId()
    const [editor, setEditor] = React.useState<{ account?: GalleryAccount; id: string } | null>(null)
    const [label, setLabel] = React.useState(''), [connecting, setConnecting] = React.useState(false), [connectionError, setConnectionError] = React.useState('')
    const [login, setLogin] = React.useState<GalleryLoginView | null>(null)
    const [verifiedAccount, setVerifiedAccount] = React.useState<GalleryAccount | null>(null)
    const labelValue = React.useRef('')
    const request = React.useRef<AbortController | null>(null), connection = React.useRef<AbortController | null>(null), sequence = React.useRef(0), alive = React.useRef(true)
    const failedAppend = React.useRef(false)
    const seenCursors = React.useRef(new Set<string>())
    const scopeHeading = React.useRef<HTMLSpanElement>(null), focusScope = React.useRef(false)
    const editorVersion = React.useRef(0)
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); connection.current?.abort() } }, [])
    const accountKey = accounts.map(account => `${account.id}:${account.userId}:${account.credentialRef}`).join('|')
    const account = accounts.find(item => item.id === selectedAccount)
    const expectedDataKey = `${selectedAccount}:${account?.userId ?? 'public'}`, dataMatches = dataKey === expectedDataKey
    const activeTab = !account || scope?.kind === 'search' ? 'search' : scope?.kind === 'bookmarks' ? 'bookmarks' : 'collections'
    const viewTabs = [
      { value: 'collections', label: <span className="vc-gallery-tab-label"><ui.IconFolderOpenOutlineRegular size={14} />{t('galleryFolders')}</span>, id: `${galleryId}-collections-tab`, panelId: `${galleryId}-collections-panel` },
      { value: 'bookmarks', label: <span className="vc-gallery-tab-label"><ui.IconPinOutlineRegular size={14} />{t('galleryBookmarks')}</span>, id: `${galleryId}-bookmarks-tab`, panelId: `${galleryId}-bookmarks-panel` },
      { value: 'search', label: <span className="vc-gallery-tab-label"><ui.IconSearchOutlineRegular size={14} />{t('galleryFullSearch')}</span>, id: `${galleryId}-search-tab`, panelId: `${galleryId}-search-panel` },
    ] as const
    const defaultAccount = source.provider === 'unsplash' && source.unsplash.defaultAccountId === (account?.id ?? null)
    const errorText = (value: unknown) => {
      const code = value && typeof value === 'object' && 'code' in value ? value.code : ''
      if (code === 'gallery-reference-limit') return t('galleryReferenceLimit')
      if (typeof code === 'string' && code.startsWith('gallery-login-')) return t(code === 'gallery-login-browser-unavailable' ? 'galleryLoginBrowserError' : code === 'gallery-login-window-closed' ? 'galleryLoginClosed' : code === 'gallery-login-timeout' ? 'galleryLoginTimeout' : code === 'gallery-login-account-mismatch' ? 'galleryAccountMismatch' : code === 'gallery-login-duplicate' ? 'galleryDuplicateAccount' : code === 'gallery-login-busy' ? 'galleryLoginBusy' : 'galleryLoginError')
      return t(code === 'source-auth-required' || code === 'configuration-required' || code === 'owner-denied' ? 'gallerySessionError' : code === 'source-continuation-invalid' ? 'galleryPageChanged' : code === 'source-rate-limited' ? 'galleryRateLimited' : code === 'source-client-unavailable' ? 'galleryClientMissing' : code === 'source-access-check' || code === 'source-access-denied' ? 'galleryAccessError' : 'galleryConnectionError')
    }
    const read = async <T,>(operation: string, args: ActionArgs, signal: AbortSignal, refresh = false): Promise<T> => await actions.galleryRead(operation, args, signal, { refresh }) as T
    const load = async (nextScope: GalleryPhotoScope | null, append = false, title = '', refresh = false) => {
      focusScope.current = nextScope?.kind === 'collection' && !append
      request.current?.abort()
      const controller = new AbortController(); request.current = controller
      failedAppend.current = false
      const current = ++sequence.current
      if (!append) seenCursors.current.clear()
      setDataKey(expectedDataKey); setLoading(true); setAppending(append); setError(''); setScope(nextScope); setFolderTitle(title)
      if (!append) { setSelected([]); setUncertainImport(false); setPhotoPage(0); setCollectionFilter(''); if (nextScope?.kind !== 'search') changeQuery(''); if (!dataMatches || JSON.stringify(scope) !== JSON.stringify(nextScope)) { if (nextScope) setPhotos({ items: [], nextCursor: null }); else setFolders({ items: [], nextCursor: null }) } }
      try {
        const args = {
          ...(account ? { accountId: account.id } : {}), ...(nextScope ? { scope: { ...nextScope } } : {}), cursor: append ? (nextScope ? photos.nextCursor : folders.nextCursor) : null,
        }
        if (nextScope) {
          const page = await read<GalleryPage<GalleryPhoto>>('gallery-photos', args, controller.signal, refresh)
          if (!alive.current || current !== sequence.current) return
          if (page.nextCursor && (page.nextCursor === args.cursor || seenCursors.current.has(page.nextCursor))) throw Object.assign(new Error('gallery-cursor-cycle'), { code: 'source-continuation-invalid' })
          const items = append ? [...new Map([...photos.items, ...page.items].map(item => [item.id, item])).values()] : page.items
          if (items.length > config.limits.maxGalleryReferenceFiles) throw Object.assign(new Error('gallery-reference-limit'), { code: 'gallery-reference-limit' })
          if (args.cursor) seenCursors.current.add(args.cursor)
          setPhotos({ ...page, items })
        } else {
          const page = await read<GalleryPage<GalleryCollection>>('gallery-collections', args, controller.signal, refresh)
          if (!alive.current || current !== sequence.current) return
          if (page.nextCursor && (page.nextCursor === args.cursor || seenCursors.current.has(page.nextCursor))) throw Object.assign(new Error('gallery-cursor-cycle'), { code: 'source-continuation-invalid' })
          if (args.cursor) seenCursors.current.add(args.cursor)
          setFolders(previous => ({ ...page, items: append ? [...new Map([...previous.items, ...page.items].map(item => [item.id, item])).values()] : page.items })); setStatus(previous => ({ ...previous, [selectedAccount]: 'ready' }))
        }
        return true
      } catch (failure) { if (alive.current && !controller.signal.aborted && current === sequence.current) { failedAppend.current = append; setError(errorText(failure)); if (!nextScope) setStatus(previous => ({ ...previous, [selectedAccount]: 'error' })) } }
      finally { if (alive.current && current === sequence.current) { setLoading(false); setAppending(false) } }
    }
    const search = async () => {
      if (locked || loading) return
      const value = query.trim()
      if (scope?.kind !== 'collection') { if (value) await load({ kind: 'search', query: value }); return }
      if (!account) return
      if (!value || !photos.nextCursor) { setCollectionFilter(value); setPhotoPage(0); return }
      request.current?.abort(); const controller = new AbortController(); request.current = controller; collectionRead.current = controller; const current = ++sequence.current
      setLoading(true); setAppending(false); setError('')
      try {
        const all = await readCollectionPhotos((cursor, signal) => read<GalleryPage<GalleryPhoto>>('gallery-photos', { accountId: account.id, scope: { ...scope }, cursor }, signal), { maxFiles: config.limits.maxGalleryReferenceFiles, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(config.limits.deadlineMs)]) })
        if (!alive.current || current !== sequence.current) return
        // 分页读取期间仍允许改词或清空，完成时采用当前输入，避免旧请求重新套用旧筛选。
        setPhotos({ items: all, nextCursor: null }); setCollectionFilter(queryValue.current.trim()); setPhotoPage(0)
      } catch (failure) { if (alive.current && !controller.signal.aborted && current === sequence.current) setError(errorText(failure)) }
      finally { if (collectionRead.current === controller) collectionRead.current = null; if (alive.current && current === sequence.current) setLoading(false) }
    }
    React.useEffect(() => {
      if (selectedAccount !== 'public' && !accounts.some(item => item.id === selectedAccount)) { setSelectedAccount('public'); return }
      if (selectedAccount === 'public') { setDataKey(expectedDataKey); request.current?.abort(); ++sequence.current; setScope({ kind: 'search', query: '' }); setPhotos({ items: [], nextCursor: null }); setSelected([]); setError(''); setLoading(false) }
      else void load(null)
    }, [selectedAccount, accountKey])
    React.useEffect(() => { if (!styles.some(style => style.styleId === targetStyle)) setTargetStyle(styles.find(style => style.styleId === selectedStyleId)?.styleId ?? styles[0]?.styleId ?? '') }, [styles.map(style => style.styleId).join('|'), selectedStyleId])
    React.useEffect(() => { if (focusScope.current && scope?.kind === 'collection') { scopeHeading.current?.focus({ preventScroll: true }); focusScope.current = false } }, [scope?.kind, folderTitle])
    const updateSource = async (next: ConfigurationView['source']) => { setSaving(true); setError(''); try { await saveSource(next) } catch (failure) { if (alive.current) setError(errorText(failure)); throw failure } finally { if (alive.current) setSaving(false) } }
    const setDefault = () => { void updateSource({ ...source, provider: 'unsplash', unsplash: { ...source.unsplash, defaultAccountId: account?.id ?? null } }).catch(() => {}) }
    const removeAccount = () => { if (!account) return; void updateSource({ ...source, unsplash: { ...source.unsplash, accounts: accounts.filter(item => item.id !== account.id), defaultAccountId: source.unsplash.defaultAccountId === account.id ? null : source.unsplash.defaultAccountId } }).catch(() => {}) }
    const begin = async (value?: GalleryAccount) => {
      const version = ++editorVersion.current, controller = new AbortController()
      connection.current?.abort(); connection.current = controller
      labelValue.current = value?.label ?? ''; setLabel(labelValue.current); setConnectionError(''); setLogin(null); setVerifiedAccount(null)
      setEditor({ ...(value ? { account: value } : {}), id: crypto.randomUUID() })
      let captured = false
      try {
        const account = await connectGalleryLogin(actions.galleryRead, { revision: config.revision, operationId: crypto.randomUUID(), ...(value ? { accountId: value.id } : {}) }, { signal: controller.signal, pollIntervalMs: source.unsplash.login.pollIntervalMs, requestTimeoutMs: config.limits.requestTimeoutMs, onStatus: view => { if (alive.current && version === editorVersion.current) { setLogin(view); setConnecting(view.state === 'ready' || view.state === 'saving' || view.state === 'saved') } } })
        controller.signal.throwIfAborted()
        captured = true; setVerifiedAccount(account)
        const saved: GalleryAccount = { ...account, label: labelValue.current.trim() || account.label }
        await saveSource(withGalleryAccount(source, saved))
        if (alive.current && version === editorVersion.current) { setEditor(null); setSelectedAccount(saved.id) }
      } catch (failure) { if (alive.current && version === editorVersion.current && !controller.signal.aborted) setConnectionError(captured ? t('gallerySaveConnectionError') : errorText(failure)) }
      finally { if (alive.current && version === editorVersion.current) setConnecting(false) }
    }
    const edit = (value?: GalleryAccount) => { void begin(value) }
    const close = () => { if (!connecting) { ++editorVersion.current; connection.current?.abort(); setEditor(null); setLogin(null); setConnectionError('') } }
    const retryConnection = async () => {
      if (!verifiedAccount) { edit(editor?.account); return }
      setConnecting(true); setConnectionError('')
      try {
        const saved = { ...verifiedAccount, label: labelValue.current.trim() || verifiedAccount.label }
        await saveSource(withGalleryAccount(source, saved))
        if (alive.current) { setEditor(null); setSelectedAccount(saved.id) }
      } catch (_error) { if (alive.current) setConnectionError(t('gallerySaveConnectionError')) }
      finally { if (alive.current) setConnecting(false) }
    }
    const importPhotos = async (analyze: boolean) => {
      const style = actions.getSnapshot().snapshot?.styles.find(item => item.styleId === targetStyle)
      if (!style || !selected.length || saving || uncertainImport) return
      if (!actions.getSnapshot().snapshot?.collectionPaging) { setError(t('galleryReferenceUnavailable')); return }
      setSaving(true); setError('')
      try {
        await actions.startGalleryReferences({ operationId: crypto.randomUUID(), styleId: style.styleId, expectedRevision: style.revision, ...(account ? { accountId: account.id } : {}), photoIds: selected, role: 'positive', analyzeAfter: analyze })
        if (alive.current) { setSelected([]); openWorkbench(style.styleId) }
      } catch (failure) { if (alive.current) { setUncertainImport(true); setError(errorText(failure)) } }
      finally { if (alive.current) setSaving(false) }
    }
    const toggle = (photoId: string, enabled: boolean) => setSelected(previous => enabled ? [...new Set([...previous, photoId])].slice(0, config.limits.maxGalleryReferenceFiles) : previous.filter(id => id !== photoId))
    const locked = saving || connecting
    const filteredPhotos = React.useMemo(() => filterGalleryPhotos(photos.items, collectionFilter), [photos.items, collectionFilter])
    const selectedIds = React.useMemo(() => new Set(selected), [selected])
    const selectablePhotos = filteredPhotos.filter(photo => !photo.premium)
    const allLoadedSelected = selectablePhotos.length > 0 && selectablePhotos.every(photo => selectedIds.has(photo.id))
    const toggleLoaded = (checked: boolean) => setSelected(previous => { const ids = new Set<string>(selectablePhotos.map(photo => photo.id)); return checked ? [...new Set([...previous, ...ids])].slice(0, config.limits.maxGalleryReferenceFiles) : previous.filter(id => !ids.has(id)) })
    const visiblePhotos = filteredPhotos.slice(0, (photoPage + 1) * config.limits.pageSize)
    const collectionSearch = scope?.kind === 'collection'
    const nextPhotos = async () => { if (visiblePhotos.length < filteredPhotos.length) setPhotoPage(value => value + 1); else if (photos.nextCursor && await load(scope, true, folderTitle)) setPhotoPage(value => value + 1) }
    const browse = (value: 'collections' | 'bookmarks' | 'search') => {
      if (value === 'collections') void load(null)
      else if (value === 'bookmarks') void load({ kind: 'bookmarks' })
      else if (query.trim() && scope?.kind !== 'collection') void load({ kind: 'search', query: query.trim() })
      else { request.current?.abort(); ++sequence.current; setDataKey(expectedDataKey); setScope({ kind: 'search', query: '' }); setPhotos({ items: [], nextCursor: null }); setSelected([]); changeQuery(''); setCollectionFilter(''); setPhotoPage(0); setError(''); setLoading(false) }
    }
    return <section className="vc-gallery-settings" aria-label={t('galleryAccounts')}>
      <header className="vc-gallery-heading"><div className="vc-gallery-brand"><h3>{t('galleryBrand')}</h3><Tag>{t('galleryAccounts')} {accounts.length}</Tag></div><div className="vc-gallery-heading-actions"><Button variant="ghost" disabled={locked} onClick={openAdvanced}>{t('galleryAdvanced')}</Button><Button variant="outline" disabled={locked} onClick={() => edit()}><ui.IconPlusOutlineRegular size={16} />{t('galleryAddAccount')}</Button></div></header>
      <div className="vc-gallery-layout">
        <div className="vc-gallery-mobile-account"><Menu open={accountMenu} onClose={() => setAccountMenu(false)} selectedId={selectedAccount} portal compact items={[{ id: 'public', label: t('galleryPublic') }, ...accounts.map(item => ({ id: item.id, label: `${item.label} · @${item.username}` }))]} onSelect={value => { setSelectedAccount(value); setAccountMenu(false) }} anchor={<Button variant="outline" className="vc-gallery-mobile-account-trigger" aria-label={t('galleryChooseAccount')} aria-haspopup="menu" aria-expanded={accountMenu} disabled={locked} onClick={() => setAccountMenu(value => !value)}><span><strong>{account?.label ?? t('galleryPublic')}</strong><small>{account ? `@${account.username}` : t('galleryPublicHint')}</small></span><ui.IconChevronDownOutlineRegular size={14} /></Button>} /></div>
        <nav className="vc-gallery-accounts" aria-label={t('galleryAccounts')}>
          <Button variant="ghost" className="vc-gallery-account vc-gallery-public-account" aria-pressed={selectedAccount === 'public'} disabled={locked} onClick={() => setSelectedAccount('public')}><span className="vc-gallery-avatar" aria-hidden="true"><ui.IconSearchOutlineRegular size={16} /></span><span><strong>{t('galleryPublicNav')}</strong><small className="vc-gallery-account-subline"><span>{t('galleryPublicNavHint')}</span>{source.provider === 'unsplash' && source.unsplash.defaultAccountId === null && <Tag>{t('galleryDefault')}</Tag>}</small></span></Button>
          <div className="vc-gallery-account-section-label">{t('galleryAccounts')}<span>{accounts.length}</span></div>
          {accounts.map(item => <Button variant="ghost" key={item.id} className="vc-gallery-account" aria-pressed={selectedAccount === item.id} disabled={locked} onClick={() => setSelectedAccount(item.id)}><span className="vc-gallery-avatar" aria-hidden="true">{(item.name || item.label).slice(0, 1).toUpperCase()}<span className="vc-gallery-account-status"><StateDot state={status[item.id] === 'error' ? 'warning' : status[item.id] === 'ready' ? 'done' : 'idle'} /></span></span><span><strong>{item.label}</strong><small className="vc-gallery-account-subline"><span>@{item.username}</span>{source.provider === 'unsplash' && source.unsplash.defaultAccountId === item.id && <Tag>{t('galleryDefault')}</Tag>}</small></span></Button>)}
          {!accounts.length && <p className="vc-gallery-sidehint">{t('galleryNoAccounts')}</p>}
        </nav>
        <div className="vc-gallery-content" aria-busy={loading || saving}>
          <div className="vc-gallery-toolbar">{account && <SegmentedTabs className="vc-gallery-tabs" variant="underline" label={t('galleryBrowse')} items={viewTabs} value={activeTab} onChange={browse} />}<div className="vc-gallery-search"><Input aria-label={t(collectionSearch ? 'galleryCollectionSearch' : 'gallerySearch')} icon={<ui.IconSearchOutlineRegular size={16} />} placeholder={t(collectionSearch ? 'galleryCollectionSearch' : 'gallerySearch')} title={collectionSearch ? t('galleryCollectionSearchHint') : undefined} value={query} disabled={locked} onChange={event => { changeQuery(event.target.value); if (collectionSearch && !event.target.value.trim()) { setCollectionFilter(''); setPhotoPage(0) } }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search() } }} /><Button variant="outline" disabled={locked || loading || !query.trim() && !collectionFilter} onClick={() => { void search() }}>{t('gallerySearchAction')}</Button></div><div className="vc-gallery-account-actions"><Button size="sm" variant="ghost" aria-label={t('galleryRefresh')} disabled={locked || loading || scope?.kind === 'search' && !scope.query} onClick={() => { void load(scope, false, folderTitle, true) }}><ui.IconRefreshOutlineRegular size={14} /><span className="vc-gallery-refresh-label">{t('refresh')}</span></Button>{account ? <Menu open={accountActions} onClose={() => setAccountActions(false)} portal compact items={[{ id: 'default', label: t(defaultAccount ? 'galleryDefaultSearch' : 'gallerySetDefault'), disabled: locked || defaultAccount }, { id: 'reconnect', label: t('galleryReconnect'), disabled: locked }, { id: 'remove', label: t('galleryRemove'), disabled: locked }]} onSelect={value => { setAccountActions(false); if (value === 'default') setDefault(); else if (value === 'reconnect') edit(account); else removeAccount() }} anchor={<Button size="sm" variant="ghost" disabled={locked} aria-label={t('galleryAccountActions')} aria-haspopup="menu" aria-expanded={accountActions} onClick={() => setAccountActions(value => !value)}>{t('galleryAccountActions')}<ui.IconChevronDownOutlineRegular size={12} /></Button>} /> : defaultAccount ? <Tag>{t('galleryCurrentSource')}</Tag> : <Button size="sm" variant="outline" disabled={locked} onClick={setDefault}>{t('gallerySetDefault')}</Button>}</div></div>
          {dataMatches && scope && (scope.kind === 'collection' || photos.items.length > 0) && <div className="vc-gallery-contextbar">
            {scope.kind === 'collection' && <div className="vc-gallery-breadcrumb"><Button size="sm" variant="ghost" disabled={locked} onClick={() => browse('collections')}><ui.IconChevronLeftOutlineRegular size={12} />{t('galleryFolders')}</Button><span ref={scopeHeading} tabIndex={-1} title={folderTitle}>{folderTitle}</span></div>}
            {photos.items.length > 0 && <div className="vc-gallery-results-tools"><Checkbox checked={allLoadedSelected} label={t('gallerySelectLoaded')} disabled={locked || uncertainImport || !selectablePhotos.length} onChange={toggleLoaded} /><span>{selectablePhotos.filter(photo => selectedIds.has(photo.id)).length} / {selectablePhotos.length}</span></div>}
          </div>}
          {!dataMatches && <GallerySkeleton kind={scope ? 'photos' : 'folders'} count={config.limits.pageSize} label={t('galleryLoading')} />}
          {viewTabs.map(view => <div className="vc-gallery-view" key={view.value} id={view.panelId} role={account ? 'tabpanel' : undefined} aria-labelledby={account ? view.id : undefined} hidden={activeTab !== view.value}>{activeTab === view.value && dataMatches && <>
          {error && <p className="vc-notice" role="alert">{error}<Button size="sm" variant="ghost" disabled={locked || loading} onClick={() => { void load(scope, failedAppend.current, folderTitle) }}>{t('retry')}</Button></p>}
          {loading && !appending ? <GallerySkeleton kind={scope ? 'photos' : 'folders'} count={config.limits.pageSize} label={t(collectionSearch && query ? 'gallerySearchingCollection' : 'galleryLoading')} /> : <>
          {!scope ? <div className="vc-gallery-folders">{folders.items.map(folder => <Button variant="ghost" className="vc-gallery-folder" key={folder.id} disabled={locked} onClick={() => { void load({ kind: 'collection', collectionId: folder.id }, false, folder.title) }}>{folder.coverUrl ? <img src={folder.coverUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <span className="vc-gallery-folder-cover"><ui.IconFolderOpenOutlineRegular size={24} /></span>}<span className="vc-gallery-folder-info"><strong>{folder.title}</strong><small>{folder.totalPhotos} {t('galleryPhotoUnit')}{folder.private && <Tag>{t('galleryPrivate')}</Tag>}</small></span></Button>)}</div> : <div className="vc-gallery-photos">{visiblePhotos.map(photo => <figure key={photo.id} data-selected={selectedIds.has(photo.id)}><GalleryPhotoPreview photo={photo} selected={selectedIds.has(photo.id)} disabled={locked || uncertainImport || photo.premium || !selectedIds.has(photo.id) && selected.length >= config.limits.maxGalleryReferenceFiles} onToggle={() => toggle(photo.id, !selectedIds.has(photo.id))} t={t} /><figcaption><Checkbox checked={selectedIds.has(photo.id)} disabled={locked || uncertainImport || photo.premium || !selectedIds.has(photo.id) && selected.length >= config.limits.maxGalleryReferenceFiles} label={photo.title} onChange={value => toggle(photo.id, value)} /><div className="vc-gallery-credit"><a href={photo.pageUrl} target="_blank" rel="noreferrer">{photo.photographer || t('galleryBrand')}</a><small>{photo.width} × {photo.height}</small>{photo.premium && <Tag>{t('galleryPremiumBrand')}</Tag>}</div></figcaption></figure>)}</div>}
          {!error && (scope ? filteredPhotos.length === 0 : folders.items.length === 0) && <div className="vc-gallery-empty"><span className="vc-gallery-empty-icon">{scope?.kind === 'search' || collectionFilter ? <ui.IconSearchOutlineRegular size={22} /> : <ui.IconFolderOpenOutlineRegular size={24} />}</span><strong>{t(collectionFilter ? 'noMatches' : !scope ? 'galleryEmptyFoldersTitle' : scope.kind === 'bookmarks' ? 'galleryEmptyBookmarksTitle' : scope.kind === 'search' && !scope.query ? 'gallerySearchTitle' : 'galleryEmptyPhotosTitle')}</strong><p>{t(collectionSearch ? 'galleryCollectionSearchHint' : !scope ? 'galleryEmptyFolders' : scope.kind === 'bookmarks' ? 'galleryEmptyBookmarks' : 'gallerySearchHint')}</p>{account && (!scope || scope.kind === 'bookmarks') && <div className="vc-gallery-empty-actions">{!scope && <Button size="sm" variant="outline" onClick={() => browse('bookmarks')}>{t('galleryViewBookmarks')}</Button>}<Button size="sm" variant="ghost" onClick={() => browse('search')}>{t('galleryFullSearch')}</Button></div>}</div>}
          <GalleryLoadMore hasMore={scope ? visiblePhotos.length < filteredPhotos.length || !!photos.nextCursor : !!folders.nextCursor} loading={loading} disabled={locked || !!error} version={scope ? `${visiblePhotos.length}:${photos.nextCursor}` : folders.items.length} kind={scope ? 'photos' : 'folders'} label={t('galleryLoading')} onLoad={() => { if (scope) void nextPhotos(); else void load(null, true) }} />
          </>}
          </>}</div>)}
          <footer className="vc-gallery-selection"><div className="vc-gallery-selection-summary"><span role="status">{saving ? <><StateDot state="ongoing" />{t('busy')}</> : <>{t('gallerySelected')} <strong>{selected.length}</strong></>}</span><Button size="sm" variant="ghost" disabled={locked || !selected.length} onClick={() => setSelected([])}>{t('galleryClearSelection')}</Button></div><div className="vc-gallery-selection-target"><span>{t('galleryTarget')}</span><Menu open={styleMenu} onClose={() => setStyleMenu(false)} portal compact selectedId={targetStyle} items={styles.map(style => ({ id: style.styleId, label: style.name }))} onSelect={value => { setTargetStyle(value); setStyleMenu(false) }} anchor={<Button size="sm" variant="outline" disabled={locked || !styles.length} aria-label={t('galleryTarget')} aria-haspopup="menu" aria-expanded={styleMenu} onClick={() => setStyleMenu(value => !value)}><span>{styles.find(style => style.styleId === targetStyle)?.name ?? t('galleryTarget')}</span><ui.IconChevronDownOutlineRegular size={12} /></Button>} /></div><div className="vc-gallery-selection-actions"><><Button size="sm" variant="outline" disabled={locked || uncertainImport || !targetStyle || !selected.length} onClick={() => { void importPhotos(false) }}>{t('galleryImport')}</Button><Button size="sm" variant="primary" disabled={locked || uncertainImport || !targetStyle || !selected.length || !config.visionConfigured} onClick={() => { void importPhotos(true) }}>{t('galleryImportAnalyze')}</Button></></div>{!styles.length && <small>{t('galleryCreateFirst')}</small>}</footer>
        </div>
      </div>
      <Modal open={!!editor} onClose={close} closeOnBackdropClick={false} title={t(editor?.account ? 'galleryReconnect' : 'galleryAddAccount')} description={t('galleryConnectionHint')} closeLabel={t('close')} className="vc-gallery-connect-modal" footer={<div className="vc-dataset-actions"><Button variant="outline" disabled={connecting} onClick={close}>{t('cancel')}</Button>{connectionError && <Button variant="primary" onClick={() => { void retryConnection() }}>{t(verifiedAccount ? 'gallerySaveConnection' : 'galleryLoginRetry')}</Button>}</div>}>
        <div className="vc-stack"><div className="vc-gallery-login-progress" role="status" aria-live="polite"><StateDot state={connectionError ? 'warning' : 'ongoing'} /><div><strong>{t(connectionError ? 'galleryLoginIncomplete' : connecting ? 'galleryConnecting' : login?.state === 'validating' ? 'galleryLoginValidating' : login?.state === 'waiting' ? 'galleryLoginWaiting' : 'galleryLoginOpening')}</strong><p>{t(login?.errorCode === 'source-access-check' || login?.errorCode === 'source-access-denied' ? 'galleryLoginAccessCheck' : 'galleryLoginHint')}</p></div></div><label>{t('galleryAccountName')}<Input value={label} maxLength={80} disabled={connecting} placeholder={t('galleryAccountNameHint')} onChange={event => { labelValue.current = event.target.value; setLabel(event.target.value) }} /></label><p className="vc-gallery-login-privacy">{t('gallerySessionSecurity')}</p>{connectionError && <p className="vc-notice" role="alert">{connectionError}</p>}</div>
      </Modal>
    </section>
  }
}
