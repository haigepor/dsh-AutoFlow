/** Saved usernames are displayed; secret drafts stay local and clear after successful writes. */
export function createConfigurationForm(React, { Input, Button, StateDot, Tag, Toast, Tooltip, Chevron }, ctx, t) {
  const h = React.createElement
  return function ConfigurationForm({ view, featureId, onSaved, className = '', section, sectionId }) {
    const [loaded, setLoaded] = React.useState(null), [text, setText] = React.useState(''), [secrets, setSecrets] = React.useState({})
    const [message, setMessage] = React.useState(''), [busy, setBusy] = React.useState(false), [acquiringToken, setAcquiringToken] = React.useState(false)
    const [draft, setDraft] = React.useState({})
    const [savedToast, setSavedToast] = React.useState('')
    const [visibleCredentials, setVisibleCredentials] = React.useState({})
    const [advancedOpen, setAdvancedOpen] = React.useState(true)
    const formId = React.useId()
    async function read(preserveDraft = false, alive = () => true) {
      const result = await ctx.remote.pluginManager.invokeAction('dsh-plugin-afp', 'configuration', { operation: 'read' })
      if (!result.ok) throw new Error()
      const value = JSON.parse(result.value.output)
      if (!alive()) return
      setLoaded(value)
      if (!preserveDraft) {
        setDraft(value.config); setText(JSON.stringify(value.config, null, 2))
        setSecrets(current => { const { usernameRef, ...rest } = current; return rest })
      }
    }
    React.useEffect(() => {
      if (view !== 'page') return
      let mounted = true
      void read(false, () => mounted).catch(() => { if (mounted) setMessage(t('configUnavailable')) })
      return () => { mounted = false }
    }, [view])
    if (view !== 'page') return t('configHelp')
    const info = key => loaded?.credentials?.[key]
    const hasCredential = key => Boolean((key === 'usernameRef' ? String(secrets[key] ?? '').trim() : secrets[key]) || info(key)?.configured)
    async function saveSecrets(keys) {
      // 凭据独立提交；后续认证或部署保存失败不会撤销已经保存的字段。
      for (const key of keys) {
        const value = key === 'usernameRef' ? String(secrets[key] ?? '').trim() : secrets[key]
        if (!value) continue
        const result = await ctx.remote.credentials.set(loaded.config[key], value)
        if (!result.ok) throw new Error()
        setSecrets(current => {
          const next = { ...current, [key]: '' }
          if (key === 'usernameRef') delete next[key]
          return next
        })
        setVisibleCredentials(current => ({ ...current, [key]: false }))
      }
    }
    async function acquireToken() {
      if (!hasCredential('usernameRef') || !hasCredential('passwordRef')) { setMessage(t('tokenCredentialsRequired')); return }
      setBusy(true); setAcquiringToken(true); setMessage('')
      try {
        await saveSecrets(['usernameRef', 'passwordRef'])
        const result = await ctx.remote.pluginManager.invokeAction('dsh-plugin-afp', 'configuration', { operation: 'acquire-token' })
        if (!result.ok) throw new Error()
        await read(true)
        setSavedToast(t('tokenAcquired'))
        onSaved?.()
      } catch (error) { setMessage(t('tokenAcquireFailed')) }
      finally { setBusy(false); setAcquiringToken(false) }
    }
    async function save() {
      setBusy(true); setMessage('')
      try {
        const next = JSON.parse(text)
        if (JSON.stringify(next) !== JSON.stringify(loaded.config)
          && ['accessTokenRef', 'usernameRef', 'passwordRef', 'visionKeyRef'].some(key => next[key] !== loaded.config[key] && secrets[key])) {
          setMessage(t('referenceChangeRequired')); return
        }
        await saveSecrets(['accessTokenRef', 'usernameRef', 'passwordRef', 'visionKeyRef'])
        if (JSON.stringify(next) !== JSON.stringify(loaded.config)) {
          const result = await ctx.remote.pluginManager.invokeAction('dsh-plugin-afp', 'configuration', { operation: 'save', config: text, revision: loaded.revision })
          if (!result.ok) throw new Error()
        }
        await read()
        setSavedToast(t('configSaved'))
        onSaved?.()
      } catch (error) { setMessage(t('configFailed')) }
      finally { setBusy(false) }
    }
    const showVision = featureId === undefined || featureId === 'refresh'
    const credentialField = key => {
      const username = key === 'usernameRef', visible = Boolean(visibleCredentials[key]), inputId = `${formId}-${key}`
      const visibilityLabel = `${t(visible ? 'hideCredential' : 'showCredential')} ${t(key)}`
      const eye = h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M1.5 8s2.25-4 6.5-4 6.5 4 6.5 4-2.25 4-6.5 4S1.5 8 1.5 8Z' }),
        h('circle', { cx: 8, cy: 8, r: 1.75 }), !visible ? h('path', { d: 'm2 2 12 12' }) : null)
      const toggle = username ? null : h(Button, { variant: 'ghost', size: 'sm', type: 'button', className: 'afp-credential-visibility',
        icon: eye, 'aria-label': visibilityLabel, 'aria-controls': inputId, 'aria-pressed': visible,
        disabled: busy || info(key)?.writable === false || !secrets[key],
        onMouseDown: event => event.preventDefault(), onClick: event => {
          const input = event.currentTarget.closest('.afp-secret-control')?.querySelector('input')
          const focused = input && input.ownerDocument.activeElement === input
          const start = input?.selectionStart, end = input?.selectionEnd, direction = input?.selectionDirection
          setVisibleCredentials(current => ({ ...current, [key]: !current[key] }))
          // 切换密码类型可能重置选区；鼠标点击保留编辑位置，键盘操作保留按钮焦点。
          if (focused) queueMicrotask(() => { if (input.isConnected) input.setSelectionRange(start, end, direction) })
        } })
      return h('div', { key, className: 'afp-form-field' },
        h('div', { className: 'afp-form-label' }, h('label', { htmlFor: inputId }, t(key)),
          h(Tag, { tone: info(key)?.configured ? 'neutral' : 'quiet' }, t(info(key)?.configured ? 'configured' : 'missing'))),
        h('div', { className: username ? undefined : 'afp-secret-control' },
          h(Input, { className: 'afp-wb-input', id: inputId, type: username || visible ? 'text' : 'password',
            autoComplete: username ? 'username' : 'new-password', spellCheck: false,
            value: secrets[key] ?? (username ? loaded.username ?? '' : ''),
            disabled: busy || info(key)?.writable === false, 'aria-label': t(key), placeholder: t('keepCredential'),
            onChange: event => {
              const value = event.target.value
              setSecrets(current => ({ ...current, [key]: value }))
              if (!value) setVisibleCredentials(current => ({ ...current, [key]: false }))
            } }),
          toggle && Tooltip ? h(Tooltip, { label: secrets[key] ? visibilityLabel : t('storedCredentialHidden'), side: 'top', portal: true }, toggle) : toggle))
    }
    const field = key => h('label', { key, className: 'afp-form-field' }, t(key),
      h(Input, { className: 'afp-wb-input', value: ['string', 'number'].includes(typeof draft[key]) ? draft[key] : '',
        type: typeof loaded.config[key] === 'number' ? 'number' : 'text', step: key === 'threshold' ? 0.01 : 1, disabled: busy, 'aria-label': t(key),
        onChange: event => {
          const next = { ...draft, [key]: typeof loaded.config[key] === 'number' ? Number(event.target.value) : event.target.value }
          setDraft(next); setText(JSON.stringify(next, null, 2))
        } }))
    const token = loaded?.token
    const tokenExpired = token?.expiresAt != null && token.expiresAt <= Date.now()
    const loading = !loaded && !message
    const visionFields = ['visionBaseUrl', 'visionKeyRef', 'visionModel']
    const budgetFields = ['targetPerCategory', 'batchSize', 'maxBatches', 'concurrency', 'threshold']
    const panelProps = value => sectionId ? { role: 'tabpanel', id: `${sectionId}-${value}-panel`, 'aria-labelledby': `${sectionId}-${value}`, hidden: section !== value } : {}
    const skeletonField = key => h('div', { key, className: 'afp-form-field', 'aria-hidden': true },
      h('span', { className: 'afp-skeleton afp-skeleton-label' }), h('span', { className: 'afp-skeleton afp-skeleton-input' }))
    // 加载和完成状态共用尺寸与列结构，避免请求完成时弹窗跳动。
    const columns = loaded || loading ? h('div', { className: 'afp-config-columns', ...(loading ? { role: 'status', 'aria-label': t('loading') } : {}) },
          h('section', { className: 'afp-config-section', ...panelProps('credentials') },
            h('h4', { className: 'afp-form-heading' }, t('accountConfiguration')),
            h('div', { className: 'afp-credential-grid' }, ...['usernameRef', 'passwordRef', 'accessTokenRef'].map(loading ? skeletonField : credentialField)),
            loading ? h('div', { className: 'afp-token-line', 'aria-hidden': true },
              h('span', { className: 'afp-skeleton afp-skeleton-label' }), h('span', { className: 'afp-skeleton afp-skeleton-button' }))
              : h('div', { className: 'afp-token-line' },
                h('span', { className: 'afp-token-state' }, t('authentication'), h(Tag, { tone: tokenExpired ? 'warning' : token?.verifiedAt ? 'success' : 'neutral' },
                  t(tokenExpired ? 'tokenExpired' : token?.verifiedAt ? 'tokenVerified' : token?.configured ? 'tokenUnverified' : 'missing'))),
                h(Button, { variant: 'outline', size: 'sm', disabled: busy || !hasCredential('usernameRef') || !hasCredential('passwordRef'),
                  'aria-busy': acquiringToken, icon: acquiringToken ? h(StateDot, { state: 'ongoing', size: 14 }) : null,
                  onClick: () => { void acquireToken() } }, acquiringToken ? t('acquiringToken') : t('acquireToken'))),
            token?.configured ? h('p', { className: 'afp-muted' }, token.expiresAt == null ? t('tokenExpiryUnknown')
              : t('tokenExpiry') + ': ' + new Date(token.expiresAt).toLocaleString()) : null),
          showVision ? h('section', { className: 'afp-config-section', ...panelProps('vision') },
            h('h4', { className: 'afp-form-heading' }, t('vision')),
            h('div', { className: 'afp-config-fields' }, ...(sectionId ? visionFields : [...visionFields, ...budgetFields]).map(loading ? skeletonField
              : key => key === 'visionKeyRef' ? credentialField(key) : field(key))),
            sectionId ? h('details', { className: 'afp-wb-budget' }, h('summary', null, t('screeningBudget')),
              h('div', { className: 'afp-config-fields afp-budget-fields' }, ...budgetFields.map(loading ? skeletonField : field)))
              : null) : null) : sectionId ? h('div', null, ...['credentials', 'vision'].map(value =>
                h('section', { key: value, ...panelProps(value) }))) : null
    const editor = loaded ? h('label', { className: 'afp-deployment' }, t('deployment'), h('textarea', { className: 'afp-input', rows: 10,
            disabled: busy, value: text, 'aria-label': t('deployment'), spellCheck: false, onChange: event => {
              setText(event.target.value)
              try { const value = JSON.parse(event.target.value); if (value && typeof value === 'object' && !Array.isArray(value)) setDraft(value) }
              catch (error) { /* 保存时校验 JSON，输入过程中保留未完成的草稿。 */ }
            } })) : loading ? h('span', { className: 'afp-skeleton afp-advanced-skeleton', 'aria-hidden': true }) : null
    const error = message ? h('p', { className: 'afp-error', role: 'alert' }, message) : null
    const footer = h('div', { className: 'afp-config-footer' }, loading
        ? h('span', { className: 'afp-skeleton afp-skeleton-button', 'aria-hidden': true })
        : h(Button, { variant: 'primary', size: 'sm', type: 'submit', disabled: busy || !loaded, 'aria-busy': busy,
          icon: busy ? h(StateDot, { state: 'ongoing', size: 14 }) : null }, t('saveConfig')))
    const advanced = sectionId
      ? h('aside', { className: 'afp-config-advanced-card', hidden: section !== 'vision', 'aria-labelledby': `${formId}-advanced-heading` },
        h(Button, { type: 'button', variant: 'ghost', size: 'sm', className: 'afp-advanced-toggle', id: `${formId}-advanced-heading`,
          'aria-expanded': advancedOpen, 'aria-controls': `${formId}-advanced-content`, onClick: () => setAdvancedOpen(current => !current) },
          h('span', null, t('advanced')), Chevron ? h(Chevron, { size: 14 }) : null),
        // 编辑区保持挂载；折叠和分区切换都保留尚未提交的 JSON。
        h('div', { className: 'afp-advanced-content', id: `${formId}-advanced-content`, hidden: !advancedOpen },
          h('p', { className: 'afp-muted' }, t('deploymentHelp')), editor))
      : loaded ? h('details', { className: 'afp-advanced' }, h('summary', null, t('advanced')),
        h('p', { className: 'afp-muted' }, t('deploymentHelp')), editor) : null
    return h('form', { className: `afp-configuration${className ? ` ${className}` : ''}`, 'data-vision': showVision,
      'data-sectioned': Boolean(sectionId), 'data-section': sectionId ? section : undefined, hidden: section === 'features', 'aria-busy': loading,
      onSubmit: event => { event.preventDefault(); if (!busy && loaded) void save() } },
      h('div', { className: 'afp-config-scroll' }, sectionId
        ? h('div', { className: 'afp-config-layout' }, h('div', { className: 'afp-config-primary' }, columns, error, footer), advanced)
        : h(React.Fragment, null, columns, advanced, error)),
      sectionId ? null : footer,
      Toast && savedToast ? h(Toast, { key: savedToast, text: savedToast, tone: 'success', holdMs: 4000, onDone: () => setSavedToast('') }) : null)
  }
}
