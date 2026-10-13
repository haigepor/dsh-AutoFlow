/** Shadow only the live upstream settings entry; disposing restores its original renderer. */
export function installSettingsPage(slots, component, locale) {
  let source, remove, reconciling = false
  const reconcile = () => {
    if (reconciling) return
    const next = slots.entries('settings.section').find(entry => entry.options.id === 'better-sidebar' && entry.component !== component)
    if (next === source) return
    reconciling = true
    try {
      remove?.()
      remove = undefined
      source = next
      if (next) remove = slots.register({
        name: 'settings.section', id: 'better-sidebar', order: next.options.order,
        label: next.options.label, priority: (next.options.priority ?? 0) - 1,
        locale, inject: next.inject,
      }, component)
    } finally { reconciling = false }
  }
  const unsubscribe = slots.subscribe('settings.section', reconcile)
  reconcile()
  return () => { unsubscribe(); remove?.() }
}
