/** Subscription accounts use the Models page's controls, theme and owner-bound action callbacks. */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { AnimatedCollapse, Button, Input, Modal, StateDot, Switch, Tag, Toast, Tooltip, IconChevronDownOutlineRegular, IconEditOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubscriptionController } from './subscription-controller.ts'
import type { SubscriptionAccount, SubscriptionWindow } from './subscription-api.ts'
import type { ModelsKey } from './locales.ts'
import { ProviderBrandIcon } from './ProviderBrandIcon.tsx'
import { SubscriptionModels } from './SubscriptionModels.tsx'
import artwork from './assets/subscription-whale-maid-v3.webp'
import css from './SubscriptionPage.module.css'

/** Page-owned reactive snapshot and narrow account callbacks. */
export interface SubscriptionInjected {
  hooks: { subscription: SubscriptionController['store'] }
  ensure: () => Promise<void>
  activate: SubscriptionController['activate']
  startLogin: SubscriptionController['startLogin']
  completeLogin: SubscriptionController['completeLogin']
  cancelLogin: SubscriptionController['cancelLogin']
  update: SubscriptionController['update']
  remove: SubscriptionController['remove']
  refresh: SubscriptionController['refresh']
  loadCatalog: SubscriptionController['loadCatalog']
  saveCatalog: SubscriptionController['saveCatalog']
  dismissNotice: SubscriptionController['dismissNotice']
  t: (key: ModelsKey) => string
}

const feedback: Readonly<Record<string, ModelsKey>> = {
  CONNECTED: 'subscriptionNoticeConnected', SAVED: 'subscriptionNoticeSaved', REMOVED: 'subscriptionNoticeRemoved', REFRESHED: 'subscriptionNoticeRefreshed', ACTIVATED: 'subscriptionNoticeActivated',
  INVALID_RESPONSE: 'subscriptionErrorInvalid', REVISION_CONFLICT: 'subscriptionErrorConflict', INVALID_STATE: 'subscriptionErrorState', INVALID_CALLBACK: 'subscriptionErrorState',
  LOGIN_EXPIRED: 'subscriptionErrorExpired', LOGIN_NOT_FOUND: 'subscriptionErrorExpired', LOGIN_IDENTITY_REQUIRED: 'subscriptionErrorIdentity', INVALID_TOKEN: 'subscriptionErrorIdentity',
  ACCOUNT_NOT_FOUND: 'subscriptionErrorMissing', LOGIN_FAILED: 'subscriptionErrorLogin', TOKEN_EXCHANGE_FAILED: 'subscriptionErrorLogin', AUTHORIZATION_DECLINED: 'subscriptionErrorLogin',
  DIRECTORY_REFRESH_FAILED: 'subscriptionErrorDirectory', ACCOUNT_RELOGIN_REQUIRED: 'subscriptionNeedsLogin',
  MODELS_SAVED: 'subscriptionNoticeModelsSaved', MODEL_NOT_AVAILABLE: 'subscriptionModelError', INVALID_IMAGE_MODEL: 'subscriptionModelError',
  CATALOG_UPDATE_REQUIRED: 'subscriptionCatalogUpgrade',
  QUOTA_REFRESH_FAILED: 'subscriptionQuotaFailed',
}
const authCopy: Readonly<Record<SubscriptionAccount['auth'], ModelsKey>> = { ready: 'subscriptionReady', refreshing: 'subscriptionRefreshing', 'refresh-required': 'subscriptionRefreshRequired', 'needs-login': 'subscriptionNeedsLogin', unknown: 'subscriptionUnknown' }

function date(value: number | undefined, unknown: string): string {
  return value === undefined || !Number.isFinite(new Date(value).getTime()) ? unknown : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value)
}

function Quota({ value, label, t, compact = false }: { value: SubscriptionWindow | undefined; label: string; t: SubscriptionInjected['t']; compact?: boolean }): ReactNode {
  const remaining = value === undefined ? undefined : Math.max(0, Math.min(100, 100 - value.usedPercent))
  const displayed = remaining === undefined ? undefined : Math.round(remaining)
  // 与显示百分比使用同一分级；未观察到额度不等于已耗尽，旧值的新鲜度另行提示。
  const level = displayed === undefined ? 'unknown' : displayed > 50 ? 'healthy' : displayed >= 20 ? 'warning' : 'critical'
  return <div className={css['quota']} data-quota-level={level}>
    <div className={css['quotaLabel']}><span>{label}</span><span>{displayed === undefined ? t('subscriptionUnknown') : t('subscriptionRemaining').replace('{percent}', String(displayed))}</span></div>
    <div className={css['quotaTrack']}
      {...remaining === undefined ? { 'aria-hidden': true } : { role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': remaining }}>
      <span style={{ width: `${remaining ?? 0}%` }} />
    </div>
    {!compact && <small>{value?.resetAt === undefined ? t('subscriptionNotObserved') : t('subscriptionReset').replace('{time}', date(value.resetAt, t('subscriptionUnknown')))}</small>}
  </div>
}

/** Render the subscription tab without reading Remote services or storing credentials.
 * @param props Injected safe view and owner-bound callbacks.
 * @returns Account list, feature activation and owned edit/login dialogs.
 */
export function SubscriptionPage(props: InjectFace<SubscriptionInjected>): ReactNode {
  const { useSubscription, ensure, activate, startLogin, completeLogin, cancelLogin, update, remove, refresh, loadCatalog, saveCatalog, t } = props
  const state = useSubscription(value => value)
  const [callback, setCallback] = useState(''), [editing, setEditing] = useState<SubscriptionAccount | null>(null), [removing, setRemoving] = useState<SubscriptionAccount | null>(null)
  const [name, setName] = useState(''), [priority, setPriority] = useState('0')
  const [modelsOpen, setModelsOpen] = useState(false)
  const [accountExpansion, setAccountExpansion] = useState<Readonly<Record<string, boolean>>>({})
  const id = useId(), busy = state.busy !== null
  useEffect(() => { void ensure() }, [ensure])
  useEffect(() => { setCallback('') }, [state.login?.loginId])
  const add = (): void => {
    // 用户手势内预留窗口，异步登录请求完成后再导航，避免被浏览器弹窗策略拦截。
    const popup = window.open('about:blank', '_blank')
    if (popup !== null) {
      popup.opener = null
      const policy = popup.document.createElement('meta'); policy.name = 'referrer'; policy.content = 'no-referrer'; popup.document.head.append(policy)
    }
    void startLogin().then(url => { if (url === undefined) popup?.close(); else if (popup !== null && !popup.closed) popup.location.replace(url) }, () => { popup?.close() })
  }
  const edit = (account: SubscriptionAccount): void => {
    setEditing(account); setName(account.label); setPriority(String(account.priority))
  }
  const toggleAccount = (accountKey: string): void => {
    // 首次操作时按稳定账号键保留所有卡片状态，后台刷新不重新折叠用户已展开的账号。
    setAccountExpansion(current => Object.fromEntries(state.accounts.map(account => {
      const expanded = current[account.accountKey] ?? false
      return [account.accountKey, account.accountKey === accountKey ? !expanded : expanded]
    })))
  }
  const available = state.availability === 'active'
  const message = (code: string): string => t(feedback[code] ?? 'subscriptionErrorUnavailable')
  const validPriority = priority.trim() !== '' && Number.isInteger(Number(priority)) && Math.abs(Number(priority)) <= 1000
  return <div className={css['page']} data-chatgpt-subscription>
    <header className={css['intro']}>
      <img src={artwork} width={104} height={104} alt="" aria-hidden="true" draggable={false} decoding="async" />
      <div className={css['introCopy']}><h2>{t('subscriptionTitle')}</h2><p>{t('subscriptionDescription')}</p>
        {available && <div className={css['summary']}><span>{t('subscriptionAccounts').replace('{count}', String(state.accounts.length))}</span>
          <span>{t('subscriptionModels').replace('{count}', String(state.models.length))}</span></div>}</div>
      <div className={css['actions']}>{available && <>
        <Button variant="outline" disabled={busy || state.status === 'loading'} onClick={() => { void refresh() }}>{t('subscriptionRefresh')}</Button>
        <Button variant="outline" disabled={busy || state.status === 'loading'} icon={<IconPlusOutlineRegular size={16} />} onClick={() => { setModelsOpen(true); void loadCatalog() }}>{t('subscriptionAddModel')}</Button>
        <Button variant="primary" disabled={busy || state.login !== null} icon={<IconPlusOutlineRegular size={16} />} onClick={add}>{t('subscriptionAdd')}</Button>
      </>}</div>
    </header>
    {state.error !== null && <div className={css['notice']} role="alert"><span>{message(state.error)}</span><Button size="sm" variant="ghost" onClick={() => { void ensure() }}>{t('retry')}</Button></div>}
    {(state.status === 'loading' || state.status === 'idle') && state.accounts.length === 0
      ? <div className={css['loading']} role="status" aria-label={t('loading')}><StateDot state="ongoing" size={24} /></div>
      : !available ? <section className={css['empty']}><div className={css['brand']}><ProviderBrandIcon provider="openai" size={32} /></div>
        <h3>{t('subscriptionEnableTitle')}</h3><p>{t(state.availability === 'restart-required' ? 'subscriptionRestart' : state.availability === 'missing' ? 'subscriptionMissing' : 'subscriptionEnableHint')}</p>
        {state.availability === 'disabled' && <Button variant="primary" disabled={busy} onClick={() => { void activate() }}>{t('subscriptionEnable')}</Button>}
        {state.availability !== 'disabled' && <Button variant="outline" disabled={busy} onClick={() => { void ensure() }}>{t('retry')}</Button>}</section>
        : state.accounts.length === 0 ? <section className={css['empty']}><div className={css['brand']}><ProviderBrandIcon provider="openai" size={32} /></div>
          <h3>{t('subscriptionEmpty')}</h3><p>{t('subscriptionEmptyHint')}</p><small>{t('subscriptionPrivate')}</small></section>
          : <div className={css['accounts']}>{state.accounts.map(account => {
            const expanded = accountExpansion[account.accountKey] ?? false
            const detailsId = `${id}-${encodeURIComponent(account.accountKey)}-details`, headingId = `${detailsId}-heading`
            return <article className={css['card']} key={account.accountKey} data-enabled={account.enabled} data-expanded={expanded}>
              <div className={css['cardHeading']}><div className={css['accountIdentity']}><div className={css['accountMark']}><ProviderBrandIcon provider="openai" size={22} /></div>
                <div><h3 id={headingId}>{account.label}</h3><p>{account.email ?? account.accountId}</p></div></div>
              <div className={css['cardTools']}>{account.plan !== undefined && <Tag tone="neutral">{account.plan.toUpperCase()}</Tag>}
                <Button variant="ghost" size="sm" className={css['expandButton']} aria-expanded={expanded} aria-controls={detailsId}
                  aria-label={`${t(expanded ? 'subscriptionCollapse' : 'subscriptionExpand')} · ${account.label}`} icon={<IconChevronDownOutlineRegular size={16} />}
                  onClick={() => { toggleAccount(account.accountKey) }}>{t(expanded ? 'subscriptionCollapse' : 'subscriptionExpand')}</Button>
              </div></div>
              <div className={css['statusRow']}><div className={css['accountStatus']}><Tag tone={!account.enabled ? 'neutral' : account.auth === 'needs-login' ? 'danger' : account.auth === 'ready' ? 'success' : 'warning'}>
                {t(!account.enabled ? 'subscriptionDisabled' : authCopy[account.auth])}</Tag>
              {account.usage?.held === true && <Tag tone="warning">{t(account.usage.heldReason === 'workspace-limit' ? 'subscriptionWorkspaceLimit' : account.usage.heldReason === 'spending-limit' ? 'subscriptionSpendingLimit' : 'subscriptionHeld')}</Tag>}
              {account.usage?.freshness === 'stale' && <span>{t('subscriptionStale')}</span>}
              {account.auth === 'needs-login' && <Button variant="ghost" size="sm" disabled={busy || state.login !== null} onClick={add}>{t('subscriptionNeedsLogin')}</Button>}</div>
              <div className={css['enabledControl']}><Switch checked={account.enabled} disabled={busy} loading={state.busy === account.accountKey} label={t('subscriptionEnabled')} onChange={(enabled) => { void update(account, { enabled }) }} />
                <span>{t(account.enabled ? 'subscriptionEnabled' : 'subscriptionDisabled')}</span></div></div>
              <AnimatedCollapse open={!expanded} keepMounted><div className={css['compactQuotas']}><Quota value={account.usage?.primary} label={t('subscriptionPrimary')} t={t} compact />
                <Quota value={account.usage?.secondary} label={t('subscriptionSecondary')} t={t} compact /></div></AnimatedCollapse>
              <AnimatedCollapse open={expanded} id={detailsId} keepMounted className={css['detailDisclosure']}><div role="region" aria-labelledby={headingId}>
                {account.usage?.status === 'error' && <div className={css['notice']} role="status"><span>{t(account.usage.errorCode === 'USAGE_TIMEOUT' ? 'subscriptionQuotaTimeout'
                  : account.usage.errorCode === 'USAGE_INVALID_RESPONSE' ? 'subscriptionQuotaInvalid' : account.usage.errorStatus === 401 ? 'subscriptionQuotaAuth'
                    : account.usage.errorStatus === 403 ? 'subscriptionQuotaDenied' : account.usage.errorStatus !== undefined ? 'subscriptionQuotaHttp' : 'subscriptionQuotaFailed')
                  .replace('{status}', String(account.usage.errorStatus ?? ''))}</span><Button variant="ghost" size="sm" disabled={busy} onClick={() => { void refresh() }}>{t('retry')}</Button></div>}
                <div className={css['quotas']}><Quota value={account.usage?.primary} label={t('subscriptionPrimary')} t={t} />
                  <Quota value={account.usage?.secondary} label={t('subscriptionSecondary')} t={t} /></div>
                <dl className={css['details']}><div className={css['workspaceDetail']}><dt>{t('subscriptionWorkspace')}</dt><dd>{account.workspace ?? account.accountId}</dd></div>
                  <div><dt>{t('subscriptionTokenExpiry')}</dt><dd>{date(account.tokenExpiresAt, t('subscriptionUnknown'))}</dd></div>
                  {account.subscriptionUntil !== undefined && <div><dt>{t('subscriptionPlanExpiry')}</dt><dd>{date(account.subscriptionUntil, t('subscriptionUnknown'))}</dd></div>}
                </dl>
                <div className={css['creditPanel']}>
                  {(account.usage?.credits !== undefined || account.usage?.unlimitedCredits === true || account.usage?.usableCredits === true || account.usage?.resetCount !== undefined) && <dl className={css['creditStats']}>
                    {(account.usage.unlimitedCredits === true || account.usage.credits !== undefined || account.usage.usableCredits === true) && <div><dt>{t('subscriptionBalance')}</dt><dd>{account.usage.unlimitedCredits === true ? t('subscriptionUnlimitedCredits') : account.usage.credits ?? t('subscriptionUnknown')}</dd></div>}
                    {account.usage.resetCount !== undefined && <div><dt>{t('subscriptionResets')}</dt><dd>{account.usage.resetCount}</dd></div>}
                  </dl>}
                  <div className={css['creditControl']}><div><span>{t('subscriptionCredits')}</span><p>{t(account.usage?.usableCredits === true ? 'subscriptionCreditAllowance' : 'subscriptionCreditsHint')}</p></div>
                    <Switch checked={account.allowCredits} disabled={busy} loading={state.busy === account.accountKey} label={t('subscriptionCredits')} onChange={(allowCredits) => { void update(account, { allowCredits }) }} />
                  </div>
                </div>
                <footer className={css['cardFooter']}><div><span>{t('subscriptionPriority')}</span><span>{account.priority}</span></div>
                  <div><Tooltip label={t('subscriptionEdit')}><Button variant="ghost" size="sm" disabled={busy} aria-label={t('subscriptionEdit')} icon={<IconEditOutlineRegular size={16} />} onClick={() => { edit(account) }} /></Tooltip>
                    <Tooltip label={t('subscriptionRemove')}><Button variant="ghost" size="sm" disabled={busy} aria-label={t('subscriptionRemove')} icon={<IconTrashOutlineRegular size={16} />} onClick={() => { setRemoving(account) }} /></Tooltip></div></footer>
              </div></AnimatedCollapse></article>
          })}</div>}
    {modelsOpen && <SubscriptionModels catalog={state.catalog} catalogStatus={state.catalogStatus} catalogError={state.catalogError} busy={busy}
      loadCatalog={loadCatalog} saveCatalog={saveCatalog} onClose={() => { setModelsOpen(false) }} t={t} />}
    <Modal open={state.login !== null} onClose={() => { if (!busy) void cancelLogin() }} title={t('subscriptionLoginTitle')} closeLabel={t('close')} closeOnBackdropClick={false} className={css['dialog'] as string}>
      <div className={css['loginBrand']}><ProviderBrandIcon provider="openai" size={30} /></div><p className={css['bodyCopy']}>{t('subscriptionLoginHint')}</p>
      <div className={css['loginState']} role="status"><StateDot state="ongoing" size={16} /><span>{t(state.login?.state === 'exchanging' ? 'subscriptionExchanging'
        : state.login?.state === 'failed' || state.login?.state === 'cancelled' ? 'subscriptionLoginFailed' : 'subscriptionWaiting')}</span></div>
      {state.login !== null && <a className={css['external']} href={state.login.authorizationUrl} target="_blank" rel="noopener noreferrer">{t('subscriptionOpenLogin')}</a>}
      <details className={css['manual']}><summary>{t('subscriptionCallback')}</summary><p>{t('subscriptionCallbackHint')}</p>
        <form onSubmit={(event) => { event.preventDefault(); void completeLogin(callback.trim()).then((saved) => { if (saved) setCallback('') }) }}>
          <Input aria-label={t('subscriptionCallback')} value={callback} placeholder={t('subscriptionCallbackPlaceholder')} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => { setCallback(event.target.value) }} />
          <Button type="submit" variant="outline" disabled={busy || callback.trim() === ''}>{t('subscriptionComplete')}</Button></form></details>
      <div className={css['dialogActions']}><Button variant="outline" disabled={busy} onClick={() => { void cancelLogin() }}>{t('subscriptionCancel')}</Button></div>
    </Modal>
    <Modal open={editing !== null} onClose={() => { if (!busy) setEditing(null) }} title={t('subscriptionEdit')} closeLabel={t('close')} className={css['dialog'] as string}>
      <form className={css['editForm']} onSubmit={(event) => { event.preventDefault(); if (editing !== null) void update(editing, { label: name.trim(), priority: Number(priority) }).then((saved) => { if (saved) setEditing(null) }) }}>
        <label htmlFor={`${id}-name`}>{t('subscriptionName')}</label><Input id={`${id}-name`} value={name} maxLength={200} disabled={busy} onChange={(event) => { setName(event.target.value) }} />
        <label htmlFor={`${id}-priority`}>{t('subscriptionPriority')}</label><Input id={`${id}-priority`} type="number" min={-1000} max={1000} step={1} value={priority} disabled={busy} onChange={(event) => { setPriority(event.target.value) }} />
        <p className={css['bodyCopy']}>{t('subscriptionEditHint')}</p><div className={css['dialogActions']}><Button variant="outline" disabled={busy} onClick={() => { setEditing(null) }}>{t('cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy || name.trim() === '' || !validPriority}>{t('subscriptionSave')}</Button></div></form>
    </Modal>
    <Modal open={removing !== null} onClose={() => { if (!busy) setRemoving(null) }} title={t('subscriptionRemoveTitle')} closeLabel={t('close')} className={css['dialog'] as string}>
      <p className={css['bodyCopy']}>{t('subscriptionRemoveHint').replace('{account}', removing?.label ?? '')}</p>
      <div className={css['dialogActions']}><Button variant="outline" disabled={busy} onClick={() => { setRemoving(null) }}>{t('cancel')}</Button>
        <Button variant="outline" className={css['danger']} disabled={busy} onClick={() => { if (removing !== null) void remove(removing).then((saved) => { if (saved) setRemoving(null) }) }}>{t('subscriptionRemove')}</Button></div>
    </Modal>
  </div>
}

/** Render transient operation feedback from an owner that outlives the settings page.
 * @param props Shared notice source and dismissal callback.
 * @returns One localized toast, or null when no operation has completed.
 */
export function SubscriptionToast({ useSubscription, t, dismissNotice }: Pick<InjectFace<SubscriptionInjected>, 'useSubscription' | 't' | 'dismissNotice'>): ReactNode {
  const notice = useSubscription(value => value.notice)
  return notice === null ? null : <Toast key={notice.id} text={t(feedback[notice.code] ?? 'subscriptionErrorUnavailable')} {...notice.success ? { tone: 'success' as const } : {}} onDone={dismissNotice} />
}
