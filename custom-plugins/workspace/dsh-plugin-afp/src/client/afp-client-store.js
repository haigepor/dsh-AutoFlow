const NAME = 'dsh-plugin-afp'
/** One shared observable for profile tasks, choices, reports and unsent form values. */
export function createAfpClientStore(ctx) {
  let state = { status: null, features: [], selected: ['food'], query: '', runId: '', operation: 'append', result: null, plan: null, busy: false, saving: [], error: '' }
  const listeners = new Set()
  let disposed = false, poll, featureQueue = Promise.resolve()
  const set = update => { if (!disposed) { state = { ...state, ...update }; for (const listener of listeners) listener() } }
  async function call(operation, args = {}) {
    const result = await ctx.remote.pluginManager.invokeAction(NAME, 'workbench', { operation, args: JSON.stringify(args) })
    if (!result.ok) throw new Error(result.error.message)
    return JSON.parse(result.value.output)
  }
  async function reload() {
    if (poll) return poll
    poll = Promise.all([call('status'), ctx.remote.pluginManager.listBundles(), ctx.remote.pluginManager.listPlugins()]).then(([status, bundles, plugins]) => {
      if (!bundles.ok) throw new Error(bundles.error.message)
      if (!plugins.ok) throw new Error(plugins.error.message)
      const bundle = bundles.value.find(bundle => bundle.name === NAME)
      if (bundle?.error) throw new Error(bundle.error.diagnostic ?? bundle.error.code)
      set({ status, features: (bundle?.features ?? []).map(feature => ({ ...feature,
        running: plugins.value.some(row => row.patchId === feature.rowId && row.enabled && row.fiberPhase === 'active') })),
        ...status.features.includes('write') ? {} : { plan: null } })
    }).catch(error => set({ error: error.message })).finally(() => { poll = null })
    return poll
  }
  const store = {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, set, reload,
    async invoke(operation, args) {
      if (state.busy) return
      set({ busy: true, error: '' })
      try {
        if (operation === 'status') { await reload(); return }
        const result = await call(operation, args)
        set({ result: operation === 'plan' ? { ...result, confirmation: undefined } : result,
          ...(operation === 'plan' ? { plan: result } : {}), ...(operation === 'confirm' ? { plan: null } : {}),
          ...(result.runId ? { runId: result.runId } : {}) })
        await reload()
      } catch (error) { set({ error: error.message, ...(operation === 'confirm' ? { plan: null } : {}) }) }
      finally { set({ busy: false }) }
    },
    toggle(id, enabled) {
      if (state.saving.includes(id)) return
      set({ saving: [...state.saving, id], error: '' })
      // 串行读取最新完整选择，连续点击不同开关时不会覆写前一个选择。
      featureQueue = featureQueue.then(async () => {
        const bundles = await ctx.remote.pluginManager.listBundles()
        if (!bundles.ok) throw new Error(bundles.error.message)
        const features = bundles.value.find(bundle => bundle.name === NAME)?.features ?? []
        const ids = features.filter(feature => feature.id === id ? enabled : feature.enabled).map(feature => feature.id)
        const result = await ctx.remote.pluginManager.setBundleFeatures(NAME, ids, false)
        if (!result.ok) throw new Error(result.error.message)
        if (result.value.application === 'failed') throw new Error(result.value.error?.diagnostic ?? 'AFP configuration save failed')
        await reload()
      }).catch(error => set({ error: error.message })).finally(() => set({ saving: state.saving.filter(key => key !== id) }))
      return featureQueue
    },
    dispose() { disposed = true; listeners.clear() },
  }
  return store
}
