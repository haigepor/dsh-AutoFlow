/** A profile-wide client store; polling observes jobs without owning them. */
const PACKAGE = 'dsh-plugin-article-image'

/** Create workbench subscriptions and serialized mutations. @param {object} ctx Client context. @returns {object} Store. */
export function createStore(ctx) {
  let state = { status: null, page: null, detail: null, selected: '', category: '', offset: 0, busy: false, error: '', lastImport: null }
  let disposed = false, timer, loading, epoch = 0
  const listeners = new Set(), controllers = new Set()
  const publish = patch => { if (!disposed) { state = { ...state, ...patch }; for (const listener of listeners) listener() } }
  async function read(operation, args = {}) {
    const controller = new AbortController(); controllers.add(controller)
    try {
      const response = await fetch(new URL('api/article-image/data', document.baseURI), { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, args }), signal: controller.signal })
      const result = await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error?.code ?? 'operation-failed')
      return result.value
    } finally { controllers.delete(controller) }
  }
  async function reload() {
    if (loading || disposed) return loading
    const version = epoch
    loading = (async () => {
      try {
        const status = await read('status'), page = await read('list', { offset: state.offset, ...(state.category ? { category: state.category } : {}) })
        if (version !== epoch) return
        const selected = state.selected || page.items[0]?.id || ''
        const detail = selected ? await read('detail', { id: selected }) : null
        if (version === epoch) publish({ status, page, selected, detail, error: '' })
      } catch (error) { publish({ error: error.message }) }
    })().finally(() => { loading = null })
    return loading
  }
  function select(id) { epoch++; publish({ selected: id, detail: null }); void (async () => { await loading; await reload() })() }
  async function mutate(operation, args) {
    if (state.busy || disposed) return
    publish({ busy: true })
    try {
      const response = await ctx.remote.pluginManager.invokeAction(PACKAGE, 'workbench', { operation, args: JSON.stringify(args) })
      if (!response.ok) throw new Error(response.error.message)
      const result = JSON.parse(response.value.output)
      if (operation === 'import') publish({ lastImport: result, offset: 0 })
      await loading; await reload()
      return result
    } finally { publish({ busy: false }) }
  }
  async function poll() { await reload(); if (!disposed) timer = setTimeout(poll, state.status?.pollIntervalMs ?? 3000) }
  void poll()
  return { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => state,
    reload, select, mutate,
    filter(category) { epoch++; publish({ category, offset: 0, selected: '', detail: null }); void (async () => { await loading; await reload() })() },
    page(offset) { epoch++; publish({ offset, selected: '', detail: null }); void (async () => { await loading; await reload() })() },
    dispose() { disposed = true; clearTimeout(timer); for (const controller of controllers) controller.abort(); listeners.clear() },
  }
}
