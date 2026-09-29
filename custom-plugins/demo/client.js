window.__ModuleLoader__.load({
  id: 'dsh-custom-plugin-demo',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NAME = 'dsh-custom-plugin-demo'
    const copy = {
      zh: {
        title: '自定义插件 Demo', settingsTitle: '插件 Demo',
        summary: '按需启用提示词、Skill 和示例执行功能。',
        prompt: '全局提示词', skill: '示例 Skill', execution: '示例执行',
        run: '运行示例脚本', result: '执行结果', unavailable: '执行功能尚未开启。',
        remove: '永久移除停用副本', confirm: '再次点击以确认永久移除', cancel: '取消',
        active: '已启用', inactive: '已停用', retained: '停用副本已保留', none: '无停用副本',
        loading: '正在读取状态…', error: '操作失败',
      },
      en: {
        title: 'Custom plugin demo', settingsTitle: 'Plugin demo',
        summary: 'Enable instructions, a Skill, and a demo operation independently.',
        prompt: 'Global instructions', skill: 'Example Skill', execution: 'Demo operation',
        run: 'Run example script', result: 'Result', unavailable: 'The executable feature is off.',
        remove: 'Permanently remove inactive copy', confirm: 'Click again to confirm permanent removal', cancel: 'Cancel',
        active: 'Enabled', inactive: 'Off', retained: 'Inactive copy retained', none: 'No inactive copy',
        loading: 'Reading status…', error: 'Operation failed',
      },
    }
    const section = { display: 'grid', gap: 12, padding: '12px 0', color: 'var(--dsw-alias-label-primary)' }
    const line = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }
    const muted = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 }
    const button = { padding: '7px 12px', border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit', cursor: 'pointer' }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.pluginManager'],
      apply(ctx) {
        const namespace = 'customPluginDemo'
        ctx.effect(() => ctx.locale.register(namespace, copy), 'demo: locale')
        const t = ctx.locale.bind(namespace)

        function DemoPanel() {
          const [state, setState] = React.useState(null)
          const [running, setRunning] = React.useState(false)
          const [output, setOutput] = React.useState('')
          const [error, setError] = React.useState('')
          const [confirm, setConfirm] = React.useState(null)

          const refresh = React.useCallback(async () => {
            const [bundles, status] = await Promise.all([
              ctx.remote.pluginManager.listBundles(),
              ctx.remote.pluginManager.invokeAction(NAME, 'status', {}),
            ])
            if (!bundles.ok) { setError(bundles.error.message); return }
            if (!status.ok) { setError(status.error.message); return }
            const bundle = bundles.value.find(item => item.name === NAME)
            setState({ features: bundle?.features ?? [], content: JSON.parse(status.value.output) })
          }, [])

          React.useEffect(() => {
            void refresh()
            return ctx.remote.$on('plugin-manager/changed', () => { void refresh() })
          }, [refresh])

          async function invoke(id) {
            setRunning(true)
            setError('')
            try {
              const result = await ctx.remote.pluginManager.invokeAction(NAME, id, {})
              if (!result.ok) throw result.error
              if (id === 'run') setOutput(result.value.output)
              await refresh()
            } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
            finally { setRunning(false); setConfirm(null) }
          }

          const enabled = state?.features.some(feature => feature.id === 'execute' && feature.enabled)
          return h('section', { style: section, 'data-demo-panel': true },
            h('h3', { style: { margin: 0, fontSize: 16 } }, t('title')),
            h('p', { style: muted }, t('summary')),
            state === null ? h('p', { style: muted }, t('loading')) : ['prompt', 'skill'].map(feature => {
              const current = state.content[feature]
              return h('div', { key: feature, style: section },
                h('div', { style: line },
                  h('strong', null, t(feature)),
                  h('span', { style: muted }, t(current.active ? 'active' : 'inactive')),
                  h('span', { style: muted }, t(current.retained ? 'retained' : 'none')),
                ),
                h('code', { style: muted }, current.path),
                !current.retained || current.active ? null : h('div', { style: line },
                  h('button', { type: 'button', style: button, disabled: running,
                    onClick: () => confirm === feature ? void invoke(`remove-${feature}`) : setConfirm(feature) },
                  t(confirm === feature ? 'confirm' : 'remove')),
                  confirm !== feature ? null : h('button', { type: 'button', style: button,
                    onClick: () => setConfirm(null) }, t('cancel')),
                ),
              )
            }),
            h('div', { style: line },
              h('strong', null, t('execution')),
              h('button', { type: 'button', style: button, disabled: !enabled || running,
                onClick: () => { void invoke('run') } }, t('run')),
              enabled ? null : h('span', { style: muted }, t('unavailable')),
            ),
            output ? h('p', { role: 'status', style: muted }, `${t('result')}: ${output}`) : null,
            error ? h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)' } },
              `${t('error')}: ${error}`) : null,
          )
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'custom-plugin-demo', order: 40,
          label: () => t('settingsTitle'), locale: namespace,
        }, DemoPanel))
      },
    }
  },
})
