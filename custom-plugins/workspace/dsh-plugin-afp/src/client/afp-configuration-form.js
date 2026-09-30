/** Credential values are write-only and cleared after submission or form unmount. */
export function createConfigurationForm(React, { Input, Button, StateDot }, ctx, t) {
  const h = React.createElement
  return function ConfigurationForm({ view }) {
    const [loaded, setLoaded] = React.useState(null), [text, setText] = React.useState(''), [secrets, setSecrets] = React.useState({})
    const [message, setMessage] = React.useState(''), [busy, setBusy] = React.useState(false), [acquiringToken, setAcquiringToken] = React.useState(false)
    const [draft, setDraft] = React.useState({})
    React.useEffect(() => {
      if (view !== 'page') return
      let mounted = true
      void ctx.remote.pluginManager.invokeAction('dsh-plugin-afp', 'configuration', { operation: 'read' }).then(result => {
        if (!mounted) return
        if (!result.ok) { setMessage(t('configFailed')); return }
        const value = JSON.parse(result.value.output)
        setLoaded(value); setDraft(value.config); setText(JSON.stringify(value.config, null, 2))
      }).catch(() => { if (mounted) setMessage(t('configFailed')) })
      return () => { mounted = false }
    }, [view])
    if (view !== 'page') return t('configHelp')
    async function credential(key) {
      setBusy(true); setMessage('')
      try {
        const result = await ctx.remote.credentials.set(loaded.config[key], secrets[key])
        if (!result.ok) throw new Error()
        setSecrets(current => ({ ...current, [key]: '' })); setMessage(t('credentialSaved'))
      } catch (error) { setMessage(t('configFailed')) }
      finally { setBusy(false) }
    }
    async function acquireToken() {
      const username = String(secrets.usernameRef ?? '').trim(), password = String(secrets.passwordRef ?? '')
      if (!username || !password) { setMessage(t('tokenCredentialsRequired')); return }
      setAcquiringToken(true)
      setBusy(true); setMessage(t('tokenAcquiring'))
      try {
        const usernameSaved = await ctx.remote.credentials.set(loaded.config.usernameRef, username)
        const passwordSaved = await ctx.remote.credentials.set(loaded.config.passwordRef, password)
        if (!usernameSaved.ok || !passwordSaved.ok) throw new Error()
        const result = await ctx.remote.pluginManager.invokeAction('dsh-plugin-afp', 'configuration', { operation: 'acquire-token' })
        if (!result.ok) throw new Error()
        setSecrets(current => ({ ...current, usernameRef: '', passwordRef: '' })); setMessage(t('tokenAcquired'))
      } catch (error) { setMessage(t('tokenAcquireFailed')) }
      finally { setBusy(false); setAcquiringToken(false) }
    }
    async function save() {
      setBusy(true); setMessage('')
      try {
        JSON.parse(text)
        const result = await ctx.remote.pluginManager.invokeAction('dsh-plugin-afp', 'configuration', { operation: 'save', config: text, revision: loaded.revision })
        if (!result.ok) throw new Error()
        setLoaded(null); setMessage(t('configSaved'))
      } catch (error) { setMessage(t('configFailed')) }
      finally { setBusy(false) }
    }
    return h('div', { className: 'afp-configuration' },
      h('p', { className: 'afp-muted' }, t('configHelp')),
      loaded ? h('div', null,
        h('div', { className: 'afp-credential-grid' }, ...['accessTokenRef', 'usernameRef', 'passwordRef', 'visionKeyRef'].map(key => h('div', { key, className: 'afp-credential-field' },
          h('label', null, h('span', null, t(key), h('small', null, loaded.config[key])),
            h(Input, { type: 'password', autoComplete: 'new-password', value: secrets[key] ?? '', 'aria-label': t(key),
              onChange: event => setSecrets(current => ({ ...current, [key]: event.target.value })) })),
          h('div', { className: 'afp-credential-actions' },
            h(Button, { variant: 'outline', size: 'sm', disabled: busy || !secrets[key], onClick: () => { void credential(key) } }, t('saveCredential')),
            key === 'accessTokenRef' ? h(Button, { variant: 'outline', size: 'sm', disabled: busy || !String(secrets.usernameRef ?? '').trim() || !String(secrets.passwordRef ?? ''), 'aria-busy': acquiringToken,
              icon: acquiringToken ? h(StateDot, { state: 'ongoing', size: 14 }) : null, onClick: () => { void acquireToken() } }, acquiringToken ? t('acquiringToken') : t('acquireToken')) : null)))),
        h('div', { className: 'afp-config-fields' }, ...['visionBaseUrl', 'visionModel', 'targetPerCategory', 'batchSize', 'maxBatches', 'concurrency'].map(key => h('label', { key }, t(key),
          h(Input, { value: ['string', 'number'].includes(typeof draft[key]) ? draft[key] : '', type: typeof loaded.config[key] === 'number' ? 'number' : 'text', 'aria-label': t(key), onChange: event => {
            const next = { ...draft, [key]: typeof loaded.config[key] === 'number' ? Number(event.target.value) : event.target.value }
            setDraft(next); setText(JSON.stringify(next, null, 2))
          } })))),
        h('details', { className: 'afp-advanced' }, h('summary', null, t('advanced')),
          h('label', { className: 'afp-deployment' }, t('deployment'), h('textarea', { className: 'afp-input', rows: 10, value: text,
            'aria-label': t('deployment'), onChange: event => { setText(event.target.value); try { const value = JSON.parse(event.target.value); if (value && typeof value === 'object' && !Array.isArray(value)) setDraft(value) } catch (error) { /* 保留无效草稿，保存时报告 JSON 错误。 */ } }, spellCheck: false }))),
        h('p', { className: 'afp-muted' }, t('deploymentHelp')),
        h('div', { className: 'afp-config-footer' }, h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => { void save() } }, t('saveConfig')))) : !message ? h('p', null, t('loading')) : null,
      message ? h('p', { role: 'status' }, message) : null)
  }
}
