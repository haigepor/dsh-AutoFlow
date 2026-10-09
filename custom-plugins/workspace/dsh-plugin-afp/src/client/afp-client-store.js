import { chooseDownloadRenditions } from './afp-download-qualities.js'
import { createPreviewCache } from './afp-preview-cache.js'

const NAME = 'dsh-plugin-afp'
const categories = ['animals', 'food', 'landscape', 'movie-poster', 'celestial-body-wallpaper']
const regionNames = ['account', 'profile', 'search', 'collections', 'collection', 'runs', 'plans', 'run', 'detail']
const emptyRegion = () => ({ data: null, loading: false, error: '' })

/** Shared profile client state for all AFP entry positions; pending page reads never own task lifetime.
 * @param {object} ctx DSH client context for profile actions.
 * @param {object} [options] Optional same-origin data transport for tests.
 * @returns {object} Store exposing snapshots, reads, actions and disposal.
 */
export function createAfpClientStore(ctx, options = {}) {
  const previews = createPreviewCache(options.previewCacheOptions)
  let state = {
    status: null, account: null, features: [], pendingTargets: {}, saving: [],
    tab: 'search', queryDraft: '', submittedQuery: '', language: '', submittedLanguage: '',
    regions: Object.fromEntries(regionNames.map(name => [name, emptyRegion()])),
    collectionId: '', collectionFilter: '', selectedPhotos: {}, photoSources: {}, selectionOpen: false, detail: null, accountVisited: false,
    collectionSelecting: false, collectionSelectionError: '', collectionSelectionIds: [],
    collectionAction: null, collectionActionResult: null,
    favoritesRequest: null, favoritesBusy: false, favoritesError: '', favoritesResult: null,
    downloadOptions: null, downloadSelected: {}, downloadOptionsLoading: false, downloadDirectory: null, downloadBulkResult: null,
    downloadPlan: null, downloadBusy: false, downloadBusyStage: '', downloadError: '', downloadErrorStage: '', downloadQuoteChanged: false, downloadResult: null,
    downloadBrowsing: false, downloadDirectoryListing: null,
    downloadDockOpen: false, downloadDockHidden: false, downloadNotice: null, downloadCancellingId: '',
    runId: '', selected: ['food'], operation: 'append', reportCategory: '', reportFilter: 'all',
    targetPerCategory: null, threshold: null, plan: null, planFingerprint: '', confirmChecked: false,
    result: null, busy: false, error: '', toast: '', previewGeneration: 0,
  }
  const listeners = new Set()
  const sequences = Object.fromEntries(regionNames.map(name => [name, 0]))
  const controllers = new Map()
  let disposed = false, poll, reloadSequence = 0, featureQueue = Promise.resolve(), actionSequence = 0
  let downloadSequence = 0, downloadController
  let collectionSelectionSequence = 0
  const searchCursors = new Set()
  const reportPages = new Map()

  function publish(update) {
    if (disposed) return
    state = { ...state, ...update }
    for (const listener of listeners) listener()
  }
  function set(update) {
    if (Object.hasOwn(update, 'collectionAction') && update.collectionAction !== state.collectionAction) {
      downloadSequence++
      downloadController?.abort()
      downloadController = null
      update = { downloadOptionsLoading: false, downloadBusy: false, downloadBusyStage: '', downloadError: '', downloadErrorStage: '', downloadBulkResult: null, downloadBrowsing: false, downloadDirectoryListing: null, ...update }
    }
    const invalidate = ['runId', 'selected', 'operation'].some(key => Object.hasOwn(update, key)
      && JSON.stringify(update[key]) !== JSON.stringify(state[key]))
    publish({ ...update, ...(invalidate ? { plan: null, planFingerprint: '', confirmChecked: false } : {}) })
  }
  async function call(operation, args = {}) {
    const result = await ctx.remote.pluginManager.invokeAction(NAME, 'workbench', { operation, args: JSON.stringify(args) })
    if (!result.ok) throw new Error(result.error.message)
    return JSON.parse(result.value.output)
  }
  async function callData(operation, args = {}, signal) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    const baseURI = options.baseURI ?? globalThis.document?.baseURI
    if (typeof fetchImpl !== 'function' || !baseURI) throw new Error('unavailable')
    const response = await fetchImpl(new URL('api/afp/workbench-data', baseURI), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation, args }), signal,
    })
    const payload = await response.json()
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error?.code ?? 'unavailable')
    return payload.value
  }
  function cancelCollectionSelection() {
    collectionSelectionSequence++
    controllers.get('collection-selection')?.abort(); controllers.delete('collection-selection')
    if (state.collectionSelecting || state.collectionSelectionError) publish({ collectionSelecting: false, collectionSelectionError: '' })
  }
  async function reload() {
    if (poll) return poll
    const sequence = ++reloadSequence
    const request = Promise.all([call('status'), ctx.remote.pluginManager.listBundles(), ctx.remote.pluginManager.listPlugins()]).then(([status, bundles, plugins]) => {
      if (!bundles.ok) throw new Error(bundles.error.message)
      if (!plugins.ok) throw new Error(plugins.error.message)
      const bundle = bundles.value.find(bundle => bundle.name === NAME)
      if (bundle?.error) throw new Error(bundle.error.diagnostic ?? bundle.error.code)
      if (disposed || sequence !== reloadSequence) return
      const readChanged = Boolean(state.status?.features?.includes('read')) !== status.features.includes('read')
      if (!status.features.includes('read')) cancelCollectionSelection()
      const priorScope = state.status?.previewCache?.scope
      if (priorScope && status.previewCache?.scope && priorScope !== status.previewCache.scope) {
        // Host 重载可改变账号端点或缓存配置；旧账号选图和请求不进入新实例。
        store.resetData()
        void store.loadAccount()
      }
      const previewsChanged = previews.configure(status.features.includes('read') ? status.previewCache ?? null : null)
      if (previewsChanged || readChanged) reportPages.clear()
      if (readChanged && !previewsChanged) previews.clear()
      publish({ status, ...(status.downloads?.some(record => record.id === state.downloadResult?.downloadId) ? { downloadResult: null } : {}),
        ...(previewsChanged || readChanged ? { previewGeneration: state.previewGeneration + 1 } : {}),
        features: (bundle?.features ?? []).map(feature => ({ ...feature,
        running: plugins.value.some(row => row.patchId === feature.rowId && row.enabled && row.fiberPhase === 'active') })),
        ...status.features.includes('write') ? {} : { plan: null, planFingerprint: '', confirmChecked: false }, error: '' })
      const report = state.regions.run.data?.run
      const latest = status.reports?.find(row => row.runId === state.runId)
      // 状态列表附带诊断，图片报告只含审核摘要；诊断变化不能清空报告并关闭预览弹窗。
      const latestRun = latest && Object.fromEntries(Object.entries(latest).filter(([key]) => key !== 'diagnostics'))
      // 续跑、取消或失败后，打开的报告必须同步保存状态，不能继续沿用旧的可写预览。
      if (report?.runId === state.runId && latestRun && !state.regions.run.loading && JSON.stringify(report) !== JSON.stringify(latestRun)) {
        void store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter })
      }
    }).catch(error => { if (!disposed && sequence === reloadSequence) publish({ error: error.message }) }).finally(() => { if (poll === request) poll = null })
    poll = request
    return request
  }
  function startRegion(name, { clearData = false, loadMode } = {}) {
    controllers.get(name)?.abort()
    const controller = new AbortController()
    controllers.set(name, controller)
    const sequence = ++sequences[name]
    publish({ regions: { ...state.regions, [name]: { ...state.regions[name], ...(clearData ? { data: null } : {}),
      ...(loadMode ? { loadMode } : {}), loading: true, error: '' } } })
    return { sequence, controller }
  }
  function finishRegion(name, sequence, data) {
    if (disposed || sequences[name] !== sequence) return false
    publish({ regions: { ...state.regions, [name]: { data, loading: false, error: '',
      ...(state.regions[name].loadMode ? { loadMode: '' } : {}) } } })
    return true
  }
  function failRegion(name, sequence, error) {
    if (disposed || sequences[name] !== sequence) return false
    publish({ regions: { ...state.regions, [name]: { ...state.regions[name], loading: false, error: error.message } } })
    return false
  }
  async function readRegion(name, operation, args) {
    const { sequence, controller } = startRegion(name)
    try { return finishRegion(name, sequence, await callData(operation, args, controller.signal)) }
    catch (error) { return failRegion(name, sequence, error) }
    finally { if (controllers.get(name) === controller) controllers.delete(name) }
  }
  function dedupeItems(left = [], right = []) {
    const items = new Map(left.map(item => [item.id, item]))
    for (const item of right) if (!items.has(item.id)) items.set(item.id, item)
    return [...items.values()]
  }
  function pageArgs(region, size) { return { offset: region?.data?.items?.length ?? 0, ...(size ? { limit: size } : {}) } }
  function currentDownload(sequence) { return !disposed && sequence === downloadSequence }
  function changedDownloadQuote(result) {
    publish({ downloadOptions: { ...state.downloadOptions, photos: result.photos, creditBalance: result.creditBalance },
      downloadSelected: Object.fromEntries(result.selected.map(item => [item.photoId, item.renditionId])),
      downloadPlan: null, downloadQuoteChanged: true, downloadError: '', downloadErrorStage: '', downloadBulkResult: null })
  }

  const store = {
    async acquirePreview(src, signal, options) {
      if (disposed) throw new DOMException('Preview request aborted', 'AbortError')
      if (!state.status?.features?.includes('read')) throw new Error('Preview unavailable')
      return previews.acquire(src, signal, options)
    },
    invalidatePreview(src, url) { previews.invalidate(src, url) },
    acquireCachedPreview(src, signal) { return state.status?.features?.includes('read') ? previews.acquireCached(src, signal) : null },
    previewCacheStats() { return previews.stats() },
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    reload,
    set,
    dismissDownloadNotice(id) { if (state.downloadNotice?.id === id) publish({ downloadNotice: null }) },
    async cancelDownload(taskId) {
      if (disposed || state.busy) return false
      const sequence = actionSequence + 1
      publish({ downloadCancellingId: taskId })
      const cancelled = await store.invoke('cancel', { taskId })
      // 账户重置或销毁后，旧取消请求不能恢复此前的通知。
      if (disposed || sequence !== actionSequence) return false
      publish({ downloadCancellingId: '', ...cancelled ? {} : { downloadNotice: { id: `cancel:${taskId}:${sequence}`, kind: 'cancelFailed' } } })
      return cancelled
    },
    planFingerprint() { return JSON.stringify([state.runId, [...state.selected].sort(), state.operation]) },
    selectTab(tab) { if (['search', 'collections', 'tasks', 'changes', 'account'].includes(tab)) set({ tab, ...(tab === 'account' ? { accountVisited: true } : {}) }) },
    selectPhoto(photo, sourceCollectionId) {
      if (!photo?.id) return
      cancelCollectionSelection()
      const selectedPhotos = { ...state.selectedPhotos, [photo.id]: photo }, photoSources = { ...state.photoSources }
      if (sourceCollectionId) photoSources[photo.id] = [...new Set([...(photoSources[photo.id] ?? []), sourceCollectionId])]
      set({ selectedPhotos, photoSources })
    },
    togglePhoto(photo, sourceCollectionId) {
      if (!photo?.id) return
      cancelCollectionSelection()
      const selectedPhotos = { ...state.selectedPhotos }, photoSources = { ...state.photoSources }
      if (selectedPhotos[photo.id]) { delete selectedPhotos[photo.id]; delete photoSources[photo.id] }
      else {
        selectedPhotos[photo.id] = photo
        if (sourceCollectionId) photoSources[photo.id] = [...new Set([...(photoSources[photo.id] ?? []), sourceCollectionId])]
      }
      set({ selectedPhotos, photoSources })
    },
    removePhoto(id) {
      cancelCollectionSelection()
      const selectedPhotos = { ...state.selectedPhotos }, photoSources = { ...state.photoSources }
      delete selectedPhotos[id]; delete photoSources[id]
      set({ selectedPhotos, photoSources })
    },
    clearSelection() { cancelCollectionSelection(); set({ selectedPhotos: {}, photoSources: {} }) },
    isCollectionFullySelected() {
      const page = state.regions.collection.data
      const ids = state.collectionSelectionIds.length ? state.collectionSelectionIds : page && !page.hasMore ? page.items.map(photo => photo.id) : []
      return ids.length > 0 && ids.every(id => state.selectedPhotos[id] && state.photoSources[id]?.includes(state.collectionId))
    },
    async toggleCollectionSelection() {
      if (state.collectionSelecting) { cancelCollectionSelection(); return false }
      const id = state.collectionId
      if (disposed || !id || !state.status?.features?.includes('read') || state.busy || state.collectionAction) return false
      if (store.isCollectionFullySelected()) {
        const ids = state.collectionSelectionIds.length ? state.collectionSelectionIds : state.regions.collection.data.items.map(photo => photo.id)
        const selectedPhotos = { ...state.selectedPhotos }, photoSources = { ...state.photoSources }
        // 仅移除当前收藏夹的选择来源；相同图片仍可由其他收藏夹选中。
        for (const photoId of ids) {
          const remaining = (photoSources[photoId] ?? []).filter(source => source !== id)
          if (remaining.length) photoSources[photoId] = remaining
          else { delete selectedPhotos[photoId]; delete photoSources[photoId] }
        }
        publish({ selectedPhotos, photoSources, collectionSelectionError: '' })
        return true
      }
      const controller = new AbortController(), sequence = ++collectionSelectionSequence
      controllers.set('collection-selection', controller)
      publish({ collectionSelecting: true, collectionSelectionError: '' })
      const current = () => !disposed && !controller.signal.aborted && sequence === collectionSelectionSequence && state.collectionId === id
      const photos = new Map()
      let offset = 0
      try {
        while (current()) {
          const page = await callData('collection-items', { collectionId: id, offset }, controller.signal)
          if (!current()) return false
          if (!Array.isArray(page.items) || page.offset !== offset || !Number.isSafeInteger(page.total) || page.total < 0 || typeof page.hasMore !== 'boolean') throw new Error('collection-selection-incomplete')
          for (const photo of page.items) {
            if (!photo || typeof photo.id !== 'string' || !photo.id) throw new Error('collection-selection-incomplete')
            photos.set(photo.id, photo)
          }
          if (!page.hasMore) {
            if (photos.size !== page.total) throw new Error('collection-selection-incomplete')
            break
          }
          if (!page.items.length) throw new Error('collection-selection-incomplete')
          offset += page.items.length
        }
        if (!current()) return false
        const selectedPhotos = { ...state.selectedPhotos }, photoSources = { ...state.photoSources }
        for (const [photoId, photo] of photos) {
          selectedPhotos[photoId] = photo
          photoSources[photoId] = [...new Set([...(photoSources[photoId] ?? []), id])]
        }
        // 完整读取后一次提交选择；不把所有页面同时塞进画廊，保持已有分页与懒加载。
        publish({ selectedPhotos, photoSources, collectionSelectionIds: [...photos.keys()] })
        return true
      } catch (error) {
        if (current()) publish({ collectionSelectionError: 'collection-selection-failed' })
        return false
      } finally {
        if (controllers.get('collection-selection') === controller) controllers.delete('collection-selection')
        if (current()) publish({ collectionSelecting: false })
      }
    },
    async loadDownloadOptions({ reset = false } = {}) {
      const photoIds = Object.keys(state.selectedPhotos)
      if (!photoIds.length) return false
      downloadController?.abort()
      const controller = new AbortController(), sequence = ++downloadSequence
      downloadController = controller
      publish({ downloadOptionsLoading: true, downloadError: '', downloadErrorStage: '', downloadQuoteChanged: false, downloadPlan: null, downloadBulkResult: null,
        ...(reset ? { downloadOptions: null, downloadSelected: {}, downloadDirectory: null } : {}) })
      try {
        const options = await callData('download-options', { photoIds }, controller.signal)
        if (!currentDownload(sequence)) return false
        const selected = chooseDownloadRenditions(options.photos ?? [], { kind: 'free' }, false)
        publish({ downloadOptions: options, downloadSelected: selected })
        return true
      } catch (error) { if (currentDownload(sequence)) publish({ downloadError: error.message, downloadErrorStage: 'options' }); return false }
      finally { if (currentDownload(sequence)) { downloadController = null; publish({ downloadOptionsLoading: false }) } }
    },
    setDownloadRendition(photoId, renditionId) {
      const downloadSelected = { ...state.downloadSelected }
      if (renditionId) downloadSelected[photoId] = renditionId
      else delete downloadSelected[photoId]
      publish({ downloadSelected, downloadPlan: null, downloadQuoteChanged: false, downloadBulkResult: null })
    },
    applyDownloadQuality(preference) {
      if (disposed || state.downloadBusy || state.downloadOptionsLoading || !state.downloadOptions || state.downloadErrorStage === 'options') return false
      const photos = state.downloadOptions.photos.filter(photo => Object.hasOwn(state.selectedPhotos, photo.id))
      const selected = chooseDownloadRenditions(photos, preference, state.status?.features?.includes('write'))
      const matched = Object.keys(selected).length
      if (!matched) return false
      // 无匹配画质的图片保留单独选择；整批更改一次发布并使旧积分确认失效。
      publish({ downloadSelected: { ...state.downloadSelected, ...selected }, downloadPlan: null, downloadQuoteChanged: false,
        downloadBulkResult: { matched, total: Object.keys(state.selectedPhotos).length } })
      return true
    },
    async browseDownloadDirectory(path) {
      if (state.downloadBusy) return false
      const sequence = downloadSequence
      publish({ downloadBusy: true, downloadBusyStage: 'directory', downloadError: '', downloadErrorStage: '' })
      try {
        const listing = await call('browse-download-directory', path ? { path } : {})
        if (!currentDownload(sequence)) return false
        publish({ downloadDirectoryListing: listing })
        return true
      } catch (error) { if (currentDownload(sequence)) publish({ downloadError: error.message, downloadErrorStage: 'directory' }); return false }
      finally { if (currentDownload(sequence)) publish({ downloadBusy: false, downloadBusyStage: '' }) }
    },
    async pickDownloadDirectory(path) {
      if (state.downloadBusy) return false
      const sequence = downloadSequence
      publish({ downloadBusy: true, downloadBusyStage: 'directory', ...(state.downloadErrorStage !== 'options' ? { downloadError: '', downloadErrorStage: '' } : {}) })
      try {
        const directory = await call('pick-download-directory', path ? { path } : {})
        if (!currentDownload(sequence)) return false
        if (directory?.browse) publish({ downloadBrowsing: true, downloadDirectoryListing: null })
        else if (directory) publish({ downloadDirectory: directory, downloadPlan: null, downloadBrowsing: false, downloadDirectoryListing: null })
        return Boolean(directory)
      } catch (error) { if (currentDownload(sequence)) publish({ downloadError: error.message, downloadErrorStage: 'directory' }); return false }
      finally {
        if (currentDownload(sequence)) {
          publish({ downloadBusy: false, downloadBusyStage: '' })
          if (state.downloadBrowsing && !state.downloadDirectoryListing && !path) void store.browseDownloadDirectory()
        }
      }
    },
    async prepareDownload({ prefix = '', suffix = '' } = {}) {
      if (!state.downloadDirectory || state.downloadBusy || state.downloadOptionsLoading || state.downloadErrorStage === 'options') return false
      const items = Object.entries(state.downloadSelected).map(([photoId, renditionId]) => ({ photoId, renditionId }))
      if (!items.length) return false
      const sequence = downloadSequence
      publish({ downloadBusy: true, downloadBusyStage: 'prepare', downloadError: '', downloadErrorStage: '', downloadPlan: null })
      try {
        const plan = await call('download-prepare', { items, directoryId: state.downloadDirectory.directoryId, prefix, suffix })
        if (!currentDownload(sequence)) return false
        if (plan.changed) {
          changedDownloadQuote(plan)
          return false
        }
        publish({ downloadPlan: plan, downloadQuoteChanged: false })
        return true
      } catch (error) { if (currentDownload(sequence)) publish({ downloadError: error.message, downloadErrorStage: 'prepare',
        ...(error.message === 'download-directory-expired' ? { downloadDirectory: null } : {}) }); return false }
      finally { if (currentDownload(sequence)) publish({ downloadBusy: false, downloadBusyStage: '' }) }
    },
    async confirmDownload() {
      const plan = state.downloadPlan
      if (!plan?.planId || !plan.confirmation || state.downloadBusy) return false
      const sequence = downloadSequence
      publish({ downloadBusy: true, downloadBusyStage: 'confirm', downloadError: '', downloadErrorStage: '' })
      try {
        const result = await call('download-confirm', { planId: plan.planId, confirmation: plan.confirmation, confirmed: true })
        if (!currentDownload(sequence)) return false
        if (result.requiresReconfirmation) {
          // 报价更新没有确认凭据，必须重新检查，不能把它作为可提交的计划。
          changedDownloadQuote(result)
          return false
        }
        // 全局下载反馈不属于弹窗，关闭或切换页面后仍可查看已接收的任务。
        set({ downloadResult: { ...result, total: plan.items.length }, collectionAction: null, downloadPlan: null, downloadQuoteChanged: false,
          downloadDockHidden: false,
          downloadNotice: { id: result.downloadId, kind: 'started', total: plan.items.length } })
        await reload()
        return true
      } catch (error) { if (currentDownload(sequence)) publish({ downloadError: error.message, downloadErrorStage: 'confirm', downloadPlan: null }); return false }
      finally { if (currentDownload(sequence)) publish({ downloadBusy: false, downloadBusyStage: '' }) }
    },
    openAddFavorites() {
      const photos = Object.values(state.selectedPhotos)
      if (!photos.length || photos.length > 120 || state.busy || state.favoritesRequest || state.collectionSelecting
        || !state.status?.features?.includes('write') || !state.status?.features?.includes('read')) return false
      // 确认界面使用打开时的批次；之后的选图变化不会进入这次远端写入。
      const request = { photos: photos.map(photo => ({ ...photo })),
        photoSources: Object.fromEntries(photos.map(photo => [photo.id, [...(state.photoSources[photo.id] ?? [])]])) }
      publish({ favoritesRequest: request, favoritesError: '', favoritesResult: null })
      void store.loadCollections()
      return true
    },
    closeAddFavorites() {
      if (state.favoritesBusy) return
      publish({ favoritesRequest: null, favoritesError: '', favoritesResult: null })
    },
    async addFavorites(targetCollectionId) {
      const request = state.favoritesRequest, target = state.regions.collections.data?.items?.find(item => item.id === targetCollectionId)
      if (!request || state.busy || state.favoritesBusy || state.favoritesResult || !target || target.readOnly || !target.name?.trim()
        || state.regions.collections.loading || state.regions.collections.error || !state.status?.features?.includes('write')
        || !state.status?.features?.includes('read') || !request.photos.length || request.photos.length > 120) return false
      const sequence = ++actionSequence
      const current = () => !disposed && actionSequence === sequence && state.favoritesRequest === request
      publish({ busy: true, favoritesBusy: true, favoritesError: '', favoritesResult: null })
      try {
        const result = await call('collection-operation', { action: 'copy', photoIds: request.photos.map(photo => photo.id),
          photoSources: request.photoSources, targetCollectionId })
        if (!current()) return false
        const photoSources = { ...state.photoSources }
        for (const row of result.items ?? []) if (row.status === 'completed' && state.selectedPhotos[row.photoId]) {
          photoSources[row.photoId] = [...new Set([...(photoSources[row.photoId] ?? []), targetCollectionId])]
        }
        publish({ favoritesResult: result, photoSources })
        // 目录刷新失败由目录区域报告，不把已确认的写入结果改成失败。
        await Promise.all([store.loadCollections(), state.collectionId ? store.openCollection(state.collectionId) : Promise.resolve()])
        return true
      } catch (error) { if (current()) publish({ favoritesError: error.message }); return false }
      finally { if (current()) publish({ busy: false, favoritesBusy: false }) }
    },
    async submitCollectionOperation(action, targetCollectionId) {
      const photoIds = Object.keys(state.selectedPhotos)
      if (!photoIds.length || state.busy || disposed) return false
      const sequence = ++actionSequence
      // 账户重置或销毁后，旧请求不能写回来源信息或解除新操作的忙碌状态。
      const current = () => !disposed && actionSequence === sequence
      publish({ busy: true, downloadError: '', collectionActionResult: null })
      try {
        const result = await call('collection-operation', { action, photoIds,
          photoSources: Object.fromEntries(photoIds.map(id => [id, state.photoSources[id] ?? []])),
          ...(targetCollectionId ? { targetCollectionId } : {}) })
        if (!current()) return false
        const photoSources = { ...state.photoSources }
        for (const row of result.items ?? []) if (row.status === 'completed' || row.status === 'partial') {
          photoSources[row.photoId] = row.sourceCollectionIds ?? []
        }
        publish({ collectionActionResult: result, photoSources })
        await Promise.all([store.loadCollections(), state.collectionId ? store.openCollection(state.collectionId) : Promise.resolve()])
        return true
      } catch (error) { if (current()) publish({ downloadError: error.message }); return false }
      finally { if (current()) publish({ busy: false }) }
    },
    closePhoto() {
      controllers.get('detail')?.abort(); controllers.delete('detail'); sequences.detail++
      publish({ detail: null, regions: { ...state.regions, detail: emptyRegion() } })
    },
    async credentialReferenceUpdated(ref) {
      const references = state.account?.references
      if (!references || [references.accessTokenRef, references.usernameRef, references.passwordRef].includes(ref)) {
        store.resetData()
        await Promise.all([store.reload(), store.loadAccount()])
      } else if (ref === references.visionKeyRef) await store.loadAccount()
    },
    async resetAndReload() {
      store.resetData()
      await Promise.all([store.reload(), store.loadAccount()])
    },
    async loadAccount() {
      const { sequence, controller } = startRegion('account')
      try {
        const account = await callData('account-summary', {}, controller.signal)
        if (!finishRegion('account', sequence, account)) return false
        publish({ account, targetPerCategory: account.settings?.targetPerCategory ?? null, threshold: account.settings?.threshold ?? null })
        return true
      } catch (error) { return failRegion('account', sequence, error) }
      finally { if (controllers.get('account') === controller) controllers.delete('account') }
    },
    async searchPhotos({ more = false } = {}) {
      const query = more ? state.submittedQuery : state.queryDraft.trim()
      if (!query) return false
      const prior = state.regions.search.data
      if (more && (!prior?.hasMore || !prior.cursor || state.regions.search.loading)) return false
      const language = more ? state.submittedLanguage : state.language
      const { sequence, controller } = startRegion('search', { clearData: !more, loadMode: more ? 'more' : 'initial' })
      if (!more) {
        searchCursors.clear()
        publish({ submittedQuery: query, submittedLanguage: language })
      }
      const args = { query, ...(language ? { language } : {}), ...(more ? { cursor: prior.cursor } : {}) }
      try {
        const page = await callData('photo-search', args, controller.signal)
        if (disposed || sequences.search !== sequence || state.submittedQuery !== query || state.submittedLanguage !== language) return false
        if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean') throw new Error('Invalid AFP search page')
        const items = dedupeItems(more ? prior.items : [], page.items)
        const validCursor = typeof page.cursor === 'string' && page.cursor.trim().length > 0 && page.cursor.length <= 8192
        // 成功页才推进游标；纯重复页和游标循环不能让用户无限请求相同内容。
        const stalled = page.hasMore && (!validCursor || !page.items.length || more && (items.length === prior.items.length || searchCursors.has(page.cursor)))
        const hasMore = page.hasMore && !stalled
        if (hasMore) searchCursors.add(page.cursor)
        const data = { ...page, items, hasMore, cursor: hasMore ? page.cursor : null, ...(stalled ? { paginationStopped: true } : {}) }
        return finishRegion('search', sequence, data)
      } catch (error) { return failRegion('search', sequence, error) }
      finally { if (controllers.get('search') === controller) controllers.delete('search') }
    },
    async loadProfile() { return readRegion('profile', 'account-profile', {}) },
    async loadCollections() { return readRegion('collections', 'collection-list', {}) },
    async openCollection(id) {
      if (!id) return false
      cancelCollectionSelection()
      store.closePhoto()
      const { sequence, controller } = startRegion('collection', { clearData: true, loadMode: 'initial' })
      publish({ collectionId: id, collectionNextOffset: 0, collectionSelectionIds: [] })
      try {
        const page = await callData('collection-items', { collectionId: id }, controller.signal)
        if (disposed || sequences.collection !== sequence || state.collectionId !== id) return false
        publish({ collectionNextOffset: page.offset + page.items.length })
        return finishRegion('collection', sequence, page)
      }
      catch (error) { return failRegion('collection', sequence, error) }
      finally { if (controllers.get('collection') === controller) controllers.delete('collection') }
    },
    async loadMoreCollection() {
      const prior = state.regions.collection.data, id = state.collectionId
      if (!prior?.hasMore || !id || state.regions.collection.loading) return false
      const { sequence, controller } = startRegion('collection', { loadMode: 'more' })
      try {
        const offset = state.collectionNextOffset ?? prior.offset + prior.items.length
        const page = await callData('collection-items', { collectionId: id, offset }, controller.signal)
        if (disposed || sequences.collection !== sequence || state.collectionId !== id) return false
        if (!Array.isArray(page.items) || page.offset !== offset || typeof page.hasMore !== 'boolean') throw new Error('Invalid AFP collection page')
        const items = dedupeItems(prior.items, page.items)
        const stalled = page.hasMore && (!page.items.length || items.length === prior.items.length)
        publish({ collectionNextOffset: page.offset + page.items.length })
        return finishRegion('collection', sequence, { ...page, items, hasMore: page.hasMore && !stalled, ...(stalled ? { paginationStopped: true } : {}) })
      } catch (error) { return failRegion('collection', sequence, error) }
      finally { if (controllers.get('collection') === controller) controllers.delete('collection') }
    },
    async loadHistory(kind, { more = false } = {}) {
      if (!['runs', 'plans'].includes(kind)) return false
      const name = kind
      const prior = state.regions[name].data
      if (more && (!prior?.hasMore || state.regions[name].loading)) return false
      const { sequence, controller } = startRegion(name, { clearData: !more })
      const args = { kind, ...(more ? pageArgs(prior) : {}) }
      try {
        const page = await callData('history-list', args, controller.signal)
        if (disposed || sequences[name] !== sequence) return false
        return finishRegion(name, sequence, more ? { ...page, items: [...prior.items, ...page.items] } : page)
      } catch (error) { return failRegion(name, sequence, error) }
      finally { if (controllers.get(name) === controller) controllers.delete(name) }
    },
    refreshCompletedTaskData() {
      if (state.regions.runs.data && !state.regions.runs.loading) void store.loadHistory('runs')
      if (state.regions.plans.data && !state.regions.plans.loading) void store.loadHistory('plans')
      if (state.runId && state.regions.run.data && !state.regions.run.loading) {
        void store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter })
      }
    },
    async openRun(id, { category = '', decision = 'all', more = false } = {}) {
      if (!id) return false
      const key = `${id}:${category}:${decision}`
      const prior = state.regions.run.data
      if (more && (!prior?.hasMore || state.regions.run.loading)) return false
      const sameRun = state.runId === id && Boolean(prior)
      const filtering = sameRun && (state.reportCategory !== category || state.reportFilter !== decision)
      if (!sameRun) reportPages.clear()
      const cached = filtering ? reportPages.get(key) : null
      const all = filtering ? reportPages.get(`${id}::all`) : null
      const known = all ?? prior
      const complete = Boolean(cached || all && !all.hasMore
        || state.reportFilter === 'all' && (!state.reportCategory || state.reportCategory === category) && !prior?.hasMore)
      // 同一报告切换筛选保留摘要和工具栏，已读结果先显示，后台仍核验保存记录。
      const visible = filtering ? cached ?? { ...known, hasMore: false, items: known.items.filter(item =>
        (!category || item.category === category) && (decision === 'all' || decision === 'failed' && item.requestFailed
          || decision === 'kept' && item.keep === true && !item.requestFailed
          || decision === 'rejected' && item.keep === false && !item.requestFailed)) } : prior
      const { sequence, controller } = startRegion('run', { clearData: !sameRun && !more,
        loadMode: filtering && !complete ? 'filter' : more ? 'more' : 'refresh' })
      publish({ runId: id, reportCategory: category, reportFilter: decision,
        ...(filtering ? { regions: { ...state.regions, run: { ...state.regions.run, data: visible } } } : {}),
        ...(more ? {} : { plan: null, planFingerprint: '', confirmChecked: false }) })
      if (more) publish({ regions: { ...state.regions, run: { ...state.regions.run, loading: true, error: '' } } })
      const args = { runId: id, decision, ...(category ? { category } : {}), ...(more ? { offset: prior?.items?.length ?? 0 } : {}) }
      try {
        const page = await callData('run-items', args, controller.signal)
        if (disposed || sequences.run !== sequence || state.runId !== id || state.reportCategory !== category || state.reportFilter !== decision) return false
        if (prior?.run && JSON.stringify(prior.run) !== JSON.stringify(page.run)) reportPages.clear()
        const data = more ? { ...page, items: [...prior.items, ...page.items] } : page
        reportPages.set(key, data)
        return finishRegion('run', sequence, data)
      } catch (error) { return failRegion('run', sequence, error) }
      finally { if (controllers.get('run') === controller) controllers.delete('run') }
    },
    async readDiagnostics(runId) {
      return callData('diagnostics', { runId })
    },
    async openPhoto(photo) {
      if (!photo?.id) return false
      publish({ detail: photo })
      const { sequence, controller } = startRegion('detail')
      try {
        const detail = await callData('photo-details', { photoId: photo.id }, controller.signal)
        if (disposed || sequences.detail !== sequence || state.detail?.id !== photo.id) return false
        const merged = detail ? { ...state.detail, ...detail } : state.detail
        if (merged) publish({ detail: merged })
        return finishRegion('detail', sequence, merged ?? photo)
      } catch (error) { return failRegion('detail', sequence, error) }
      finally { if (controllers.get('detail') === controller) controllers.delete('detail') }
    },
    async previewPlan() {
      const fingerprint = store.planFingerprint()
      if (state.busy || !state.status?.features?.includes('write') || !state.selected.length
        || state.operation !== 'clear' && !state.runId.trim()) return false
      const args = { operation: state.operation, categories: state.selected,
        ...(state.operation === 'clear' ? {} : { runId: state.runId.trim() }) }
      publish({ busy: true, plan: null, planFingerprint: '', confirmChecked: false, error: '' })
      const sequence = ++actionSequence
      try {
        const plan = await call('plan', args)
        if (disposed || sequence !== actionSequence || store.planFingerprint() !== fingerprint) return false
        publish({ plan, planFingerprint: fingerprint, confirmChecked: false })
        return true
      } catch (error) { if (!disposed && sequence === actionSequence) publish({ error: error.message }); return false }
      finally { if (!disposed && sequence === actionSequence) publish({ busy: false }) }
    },
    async confirmPlan() {
      const plan = state.plan, fingerprint = store.planFingerprint()
      if (state.busy || !plan || !state.status?.features?.includes('write') || !state.confirmChecked
        || state.planFingerprint !== fingerprint || !Number.isFinite(plan.expiresAt) || plan.expiresAt <= Date.now()) return false
      publish({ busy: true, plan: null, planFingerprint: '', confirmChecked: false, error: '' })
      const sequence = ++actionSequence
      try {
        const result = await call('confirm', { planId: plan.planId, confirmation: plan.confirmation, confirmed: true })
        if (disposed || sequence !== actionSequence) return false
        publish({ result, toast: 'writeSubmitted' })
        await reload()
        void store.loadHistory('plans')
        return true
      } catch (error) { if (!disposed && sequence === actionSequence) publish({ error: error.message }); return false }
      finally { if (!disposed && sequence === actionSequence) publish({ busy: false }) }
    },
    async invoke(operation, args = {}) {
      if (state.busy) return false
      const sequence = ++actionSequence
      publish({ busy: true, error: '' })
      try {
        const result = operation === 'status' ? (await reload(), state.status) : await call(operation, args)
        if (disposed || sequence !== actionSequence) return false
        if (operation !== 'status') publish({ result, ...(operation === 'refresh' ? { toast: 'refreshSubmitted' } : {}) })
        if (result.runId) set({ runId: result.runId })
        if (operation !== 'status') await reload()
        return true
      } catch (error) { if (!disposed && sequence === actionSequence) publish({ error: error.message }); return false }
      finally { if (!disposed && sequence === actionSequence) publish({ busy: false }) }
    },
    async toggle(id, enabled) {
      if (state.saving.includes(id)) return featureQueue
      publish({ saving: [...state.saving, id], pendingTargets: { ...state.pendingTargets, [id]: enabled }, error: '' })
      featureQueue = featureQueue.then(async () => {
        const bundles = await ctx.remote.pluginManager.listBundles()
        if (!bundles.ok) throw new Error(bundles.error.message)
        const features = bundles.value.find(bundle => bundle.name === NAME)?.features ?? []
        const ids = features.filter(feature => feature.id === id ? enabled : feature.enabled).map(feature => feature.id)
        const result = await ctx.remote.pluginManager.setBundleFeatures(NAME, ids, false)
        if (!result.ok) throw new Error(result.error.message)
        if (result.value.application === 'failed') throw new Error(result.value.error?.diagnostic ?? 'AFP configuration save failed')
        await reload()
      }).catch(async error => { await reload(); publish({ error: error.message }) }).finally(() => {
        const pendingTargets = { ...state.pendingTargets }
        delete pendingTargets[id]
        publish({ saving: state.saving.filter(key => key !== id), pendingTargets })
      })
      return featureQueue
    },
    resetData() {
      searchCursors.clear()
      reportPages.clear()
      cancelCollectionSelection()
      previews.configure(null); previews.clear()
      downloadSequence++; downloadController?.abort(); downloadController = null
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      for (const name of regionNames) sequences[name]++
      reloadSequence++
      poll = null
      actionSequence++
      publish({ previewGeneration: state.previewGeneration + 1, account: null, status: null, features: [], queryDraft: '', submittedQuery: '', language: '', submittedLanguage: '',
        regions: Object.fromEntries(regionNames.map(name => [name, emptyRegion()])), collectionId: '', collectionNextOffset: 0, collectionFilter: '',
        selectedPhotos: {}, photoSources: {}, selectionOpen: false, detail: null, runId: '', selected: ['food'], operation: 'append', reportCategory: '',
        collectionSelecting: false, collectionSelectionError: '', collectionSelectionIds: [],
        favoritesRequest: null, favoritesBusy: false, favoritesError: '', favoritesResult: null,
        collectionAction: null, collectionActionResult: null, downloadOptions: null, downloadSelected: {}, downloadOptionsLoading: false, downloadBulkResult: null,
        downloadDirectory: null, downloadPlan: null, downloadBusy: false, downloadBusyStage: '', downloadError: '', downloadErrorStage: '', downloadQuoteChanged: false, downloadResult: null,
        downloadBrowsing: false, downloadDirectoryListing: null,
        downloadDockOpen: false, downloadDockHidden: false, downloadNotice: null, downloadCancellingId: '',
        reportFilter: 'all', targetPerCategory: null, threshold: null, plan: null, planFingerprint: '',
        confirmChecked: false, result: null, busy: false, toast: '', error: '' })
    },
    dispose() { disposed = true; reportPages.clear(); listeners.clear(); actionSequence++; downloadSequence++; downloadController?.abort(); for (const name of regionNames) sequences[name]++; for (const controller of controllers.values()) controller.abort(); controllers.clear(); return previews.dispose() },
  }
  store.conversationData = callData
  return store
}
