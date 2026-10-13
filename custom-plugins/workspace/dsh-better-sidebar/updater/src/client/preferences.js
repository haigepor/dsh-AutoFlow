/** Serialize preference intents against acknowledged values; failed writes cannot leak into later patches. */
export function createPreferences(api, store, parse, notify) {
  let current = store.getPrefs(), revision, ready = false, loading = false, error = null, disposed = false, running = false
  const queue = []
  const snapshot = () => ({ prefs: queue.reduce((value, task) => ({ ...value, ...task.patch(value) }), current), ready, loading, pending: queue.length, error })
  const publish = () => { if (!disposed) notify(snapshot()) }
  const drain = async () => {
    if (running) return
    running = true
    while (queue.length) {
      const task = queue[0]
      let ok = false
      try {
        const result = await api.settingsUpdate(task.patch(current), revision)
        current = parse(result.value)
        revision = result.revision
        store.setPrefs(current)
        error = null
        ok = true
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
        // 冲突后刷新修订号，但不重试覆盖其他窗口的修改。
        try { const result = await api.settingsGet(); current = parse(result.value); revision = result.revision; store.setPrefs(current) }
        catch (refreshError) { error += ` (${String(refreshError)})`; ready = false }
      }
      queue.shift()
      task.resolve(ok)
      if (!ready) { for (const pending of queue.splice(0)) pending.resolve(false) }
      publish()
    }
    running = false
  }
  return {
    snapshot,
    async load() {
      if (loading || running) return
      loading = true; publish()
      try { const result = await api.settingsGet(); current = parse(result.value); revision = result.revision; ready = true; error = null; store.setPrefs(current) }
      catch (caught) { ready = false; error = String(caught) }
      finally { loading = false; publish() }
    },
    write(patch) {
      if (!ready || disposed) return Promise.resolve(false)
      return new Promise(resolve => { queue.push({ patch, resolve }); error = null; publish(); void drain() })
    },
    // 已提交的写入仍按顺序完成；离开页面后不再通知已卸载组件。
    dispose() { disposed = true },
  }
}
