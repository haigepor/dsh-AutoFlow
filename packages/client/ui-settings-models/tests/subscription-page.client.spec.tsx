// @vitest-environment jsdom
/** Real page/store integration: authorization updates both catalog and provider tabs without remounting. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { SubscriptionPage, SubscriptionToast, type SubscriptionInjected } from '../src/client/SubscriptionPage.tsx'
import { SubscriptionController } from '../src/client/subscription-controller.ts'
import { SubscriptionFailure, type SubscriptionOperations } from '../src/client/subscription-api.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { ModelsDirectory } from '../src/client/ModelsDirectory.tsx'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

const owners: SubscriptionController[] = []
afterEach(async () => { cleanup(); for (const owner of owners.splice(0)) await owner.dispose(); vi.restoreAllMocks() })
const t: SubscriptionInjected['t'] = key => en[key]
const rawAccount = { accountKey: 'account-fixture', accountId: 'workspace-fixture', label: 'ChatGPT fixture', email: 'owner@example.test', plan: 'plus', workspace: 'Workspace fixture',
  enabled: true, allowCredits: false, priority: 1, revision: 1, tokenExpiresAt: 2000000000000, auth: { state: 'ready' }, modelsStatus: 'ready',
  usage: { status: 'ready', freshness: 'fresh', fetchedAt: 1800000000000, primary: { usedPercent: 25, resetAt: 2000000000000 }, secondary: { usedPercent: 50, resetAt: 2000000000000 } } }

function face(owner: SubscriptionController) {
  return { useSubscription: bindSnapshotSelector(owner.store), t, ensure: () => owner.ensure(), activate: () => owner.activate(),
    startLogin: () => owner.startLogin(),
    completeLogin: (value: string) => owner.completeLogin(value), cancelLogin: () => owner.cancelLogin(),
    loadCatalog: () => owner.loadCatalog(), saveCatalog: owner.saveCatalog.bind(owner),
    update: (account: Parameters<SubscriptionController['update']>[0], patch: Parameters<SubscriptionController['update']>[1]) => owner.update(account, patch),
    remove: (account: Parameters<SubscriptionController['remove']>[0]) => owner.remove(account), refresh: () => owner.refresh(), dismissNotice: () => { owner.dismissNotice() } }
}

it('sign-in only saves the account; explicitly adding a model updates both sibling directories', async () => {
  let connected = false, configured = false
  const view: SettingsNamespaceView = { ns: 'codex-subscription', schema: {}, value: {}, autoGenerate: false, applies: 'live', secrets: [], revision: 0 }
  const discovery = vi.fn(async () => ({ ok: true as const, value: connected && configured ? [{ id: 'gpt-ui-fixture', name: 'GPT UI fixture', contextWindow: 65536, inputModalities: ['text' as const, 'image' as const] }] : [] }))
  // The wire fixture supplies only the namespaces the two real object-layer controllers consume.
  const ctx = { remote: { llm: {
    listProviders: async () => ({ ok: true, value: [{ id: 'autoflow-codex', name: 'ChatGPT / Codex' }] }),
    listConfigurableProviders: async () => ({ ok: true, value: [{ provider: 'autoflow-codex', displayName: 'ChatGPT / Codex', settingsNs: 'codex-subscription', settingsPath: [], nativeAuth: { env: [], oauth: true } }] }),
    discoverModels: discovery,
  }, settings: { describe: async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [view] } }) },
  credentials: { describe: async () => ({ ok: true, value: {} }) } } } as never
  const models = new ModelsSettingsStore(ctx, settingsSchema, new SettingsDescribeMirror(ctx))
  await models.loadModels()
  const operations: SubscriptionOperations = { availability: async () => 'active', activate: async () => 'active', invoke: async (operation) => {
    if (operation === 'account-list') return connected ? [rawAccount] : []
    if (operation === 'model-list') return connected ? [{ id: 'gpt-ui-fixture', name: 'GPT UI fixture' }] : []
    if (operation === 'model-catalog') return { revision: 0, entries: [], defaultImageModel: 'gpt-image-fixture', candidates: [{ id: 'gpt-ui-fixture', name: 'GPT UI fixture' }] }
    if (operation === 'model-catalog-save') { configured = true; return { revision: 1, entries: [{ kind: 'text', id: 'gpt-ui-fixture', name: 'GPT UI fixture' }], defaultImageModel: 'gpt-image-fixture', candidates: [{ id: 'gpt-ui-fixture', name: 'GPT UI fixture' }] } }
    if (operation === 'login-start') return { loginId: 'login-ui', state: 'waiting', authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fixture', expiresAt: Date.now() + 60000 }
    if (operation === 'login-complete') { connected = true; return { loginId: 'login-ui', state: 'authorized', authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fixture', expiresAt: Date.now() + 60000 } }
    throw new Error('Unexpected management operation')
  } }
  const owner = new SubscriptionController(() => models.load()); owner.connect(operations); owners.push(owner)
  const injected = face(owner), useModels = bindSnapshotSelector(models.store)
  vi.spyOn(window, 'open').mockReturnValue(null)
  function Page() {
    const state = useModels(value => value)
    return <><ModelsDirectory state={state} schema={settingsSchema} t={t} onEdit={() => {}} onRemove={() => {}} onRetry={() => {}}
      removable={() => false}
      renderSlot={() => <SubscriptionPage {...injected} />} /><SubscriptionToast {...injected} /></>
  }
  render(<Page />)
  fireEvent.click(screen.getByRole('tab', { name: en.providers }))
  expect(screen.getByText(en.providerModelCount.replace('{count}', '0'))).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: en.subscriptionTab }))
  expect(await screen.findByText(en.subscriptionEmpty)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.subscriptionAdd }))
  const dialog = await screen.findByRole('dialog', { name: en.subscriptionLoginTitle })
  expect(within(dialog).getByRole('link', { name: en.subscriptionOpenLogin }).getAttribute('href')).toMatch(/^https:\/\/auth.openai.com\//)
  fireEvent.click(within(dialog).getByText(en.subscriptionCallback, { selector: 'summary' }))
  fireEvent.change(within(dialog).getByRole('textbox', { name: en.subscriptionCallback }), { target: { value: 'http://localhost:1455/auth/callback?code=fixture&state=fixture' } })
  fireEvent.click(within(dialog).getByRole('button', { name: en.subscriptionComplete }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(await screen.findByText(en.subscriptionNoticeConnected)).toBeTruthy()
  expect(screen.getByRole('tab', { name: en.subscriptionTab }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByText('owner@example.test')).toBeTruthy()
  expect(screen.getByRole('meter', { name: en.subscriptionPrimary }).getAttribute('aria-valuenow')).toBe('75')
  fireEvent.click(screen.getByRole('tab', { name: en.modelDirectory }))
  expect(screen.queryByText('GPT UI fixture')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: en.providers }))
  expect(screen.getByText(en.directoryAuthManaged)).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: en.subscriptionTab }))
  await waitFor(() => { expect(screen.getByRole('button', { name: en.subscriptionAddModel }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.subscriptionAddModel }))
  const modelDialog = await screen.findByRole('dialog', { name: en.subscriptionManageModels })
  fireEvent.click(await within(modelDialog).findByRole('button', { name: en.subscriptionModelId }))
  fireEvent.click(await screen.findByRole('menuitem', { name: /GPT UI fixture/ }))
  fireEvent.click(within(modelDialog).getByRole('button', { name: en.subscriptionSaveAllModels }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  fireEvent.click(screen.getByRole('tab', { name: en.modelDirectory }))
  expect(screen.getByText('GPT UI fixture')).toBeTruthy(); expect(screen.getByText(`65,536 ${en.directoryTokens}`)).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: en.providers }))
  const panel = screen.getByRole('tabpanel', { name: en.providers })
  expect(within(panel).getByText(en.providerModelCount.replace('{count}', '1'))).toBeTruthy()
  expect(within(panel).getByText(en.accountSignedIn)).toBeTruthy()
  expect(discovery.mock.calls.length).toBeGreaterThanOrEqual(2)
})

it('a failed account removal leaves the account, confirmation and localized outcome visible', async () => {
  const owner = new SubscriptionController(async () => {}); owners.push(owner)
  owner.connect({ availability: async () => 'active', activate: async () => 'active', invoke: async (operation) => {
    if (operation === 'account-list') return [rawAccount]
    if (operation === 'model-list') return []
    throw new SubscriptionFailure('REVISION_CONFLICT')
  } })
  const injected = face(owner)
  render(<><SubscriptionPage {...injected} /><SubscriptionToast {...injected} /></>)
  await screen.findByText('owner@example.test')
  fireEvent.click(screen.getByRole('button', { name: `${en.subscriptionExpand} · ${rawAccount.label}` }))
  fireEvent.click(screen.getByRole('button', { name: en.subscriptionRemove }))
  const dialog = screen.getByRole('dialog', { name: en.subscriptionRemoveTitle })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en.subscriptionRemove })) })
  expect(screen.getByRole('dialog', { name: en.subscriptionRemoveTitle })).toBeTruthy()
  expect(screen.getByText('owner@example.test')).toBeTruthy()
  expect(screen.getByText(en.subscriptionErrorConflict)).toBeTruthy()
})

it.each([false, true])('image model configuration changes its default only after an explicit switch (%s)', async (changeDefault) => {
  const owner = new SubscriptionController(async () => {}); owners.push(owner)
  const saves: Record<string, unknown>[] = []
  const catalog = { revision: 7, entries: [], defaultImageModel: 'gpt-image-fixture', candidates: [] }
  owner.connect({ availability: async () => 'active', activate: async () => 'active', invoke: async (operation, args) => {
    if (operation === 'account-list') return [rawAccount]
    if (operation === 'model-list') return []
    if (operation === 'model-catalog') return catalog
    if (operation === 'model-catalog-save') { saves.push(args); return { ...catalog, revision: 8, entries: args['entries'] } }
    throw new Error('Unexpected operation')
  } })
  render(<SubscriptionPage {...face(owner)} />)
  await waitFor(() => { expect(screen.getByRole('button', { name: en.subscriptionAddModel }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.subscriptionAddModel }))
  const dialog = await screen.findByRole('dialog', { name: en.subscriptionManageModels })
  fireEvent.click(await within(dialog).findByRole('tab', { name: en.subscriptionImageModel }))
  fireEvent.change(within(dialog).getByRole('textbox', { name: en.subscriptionModelId }), { target: { value: 'image-other' } })
  fireEvent.change(within(dialog).getByRole('textbox', { name: en.subscriptionModelName }), { target: { value: 'My images' } })
  if (changeDefault) fireEvent.click(within(dialog).getByRole('switch', { name: en.subscriptionUseImageDefault }))
  expect(saves).toHaveLength(0)
  fireEvent.click(within(dialog).getByRole('button', { name: en.subscriptionSaveAllModels }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(saves[0]).toMatchObject({ revision: 7, entries: [{ kind: 'image', id: 'image-other', name: 'My images' }] })
  if (changeDefault) expect(saves[0]?.['defaultImageModel']).toBe('image-other')
  else expect(saves[0]).not.toHaveProperty('defaultImageModel')
})

it('a failed quota query explains the failure while keeping last-known allowance visible', async () => {
  const owner = new SubscriptionController(async () => {}); owners.push(owner)
  owner.connect({ availability: async () => 'active', activate: async () => 'active', invoke: async operation => operation === 'account-list'
    ? [{ ...rawAccount, usage: { ...rawAccount.usage, status: 'error', freshness: 'stale', errorCode: 'USAGE_HTTP_FAILED', errorStatus: 503 } }] : [] })
  render(<SubscriptionPage {...face(owner)} />)
  fireEvent.click(await screen.findByRole('button', { name: `${en.subscriptionExpand} · ${rawAccount.label}` }))
  expect(await screen.findByText(en.subscriptionQuotaHttp.replace('{status}', '503'))).toBeTruthy()
  expect(screen.getByRole('meter', { name: en.subscriptionPrimary }).getAttribute('aria-valuenow')).toBe('75')
  expect(screen.getByText(en.subscriptionStale)).toBeTruthy()
})

it('extra credits require an explicit toggle and stay disabled after a refused account update', async () => {
  const owner = new SubscriptionController(async () => {}); owners.push(owner)
  const invoke = vi.fn(async (operation: string) => {
    if (operation === 'account-list') return [{ ...rawAccount, usage: { ...rawAccount.usage, credits: { balance: '150.00' }, resetCredits: { availableCount: 0 } } }]
    if (operation === 'model-list') return []
    throw new SubscriptionFailure('REVISION_CONFLICT')
  })
  owner.connect({ availability: async () => 'active', activate: async () => 'active', invoke })
  render(<><SubscriptionPage {...face(owner)} /><SubscriptionToast {...face(owner)} /></>)
  fireEvent.click(await screen.findByRole('button', { name: `${en.subscriptionExpand} · ${rawAccount.label}` }))
  const toggle = await screen.findByRole('switch', { name: en.subscriptionCredits })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(invoke.mock.calls.map(([operation]) => operation)).not.toContain('account-update')
  await act(async () => { fireEvent.click(toggle) })
  expect(screen.getByText(en.subscriptionErrorConflict)).toBeTruthy()
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})

it('disabled access offers activation instead of a nonfunctional account button', async () => {
  const owner = new SubscriptionController(async () => {}); owners.push(owner)
  owner.connect({ availability: async () => 'disabled', activate: async () => 'restart-required', invoke: async () => { throw new Error('Do not call a disabled plugin') } })
  render(<SubscriptionPage {...face(owner)} />)
  fireEvent.click(await screen.findByRole('button', { name: en.subscriptionEnable }))
  expect(await screen.findByText(en.subscriptionRestart)).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.subscriptionAdd })).toBeNull()
})

it.each([
  [49, 'healthy', 51], [50, 'warning', 50], [80, 'warning', 20], [81, 'critical', 19], [100, 'critical', 0], [undefined, 'unknown', undefined],
])('quota presentation reflects remaining allowance without treating unknown as empty (%s)', async (usedPercent, level, remaining) => {
  const owner = new SubscriptionController(async () => {}); owners.push(owner)
  owner.connect({ availability: async () => 'active', activate: async () => 'active', invoke: async operation => operation === 'account-list'
    ? [{ ...rawAccount, usage: usedPercent === undefined ? undefined : { ...rawAccount.usage, primary: { usedPercent } } }] : [] })
  render(<SubscriptionPage {...face(owner)} />)
  fireEvent.click(await screen.findByRole('button', { name: `${en.subscriptionExpand} · ${rawAccount.label}` }))
  const details = within(await screen.findByRole('region', { name: rawAccount.label }))
  expect(details.getByText(en.subscriptionPrimary).closest('[data-quota-level]')?.getAttribute('data-quota-level')).toBe(level)
  if (remaining === undefined) expect(details.queryByRole('meter', { name: en.subscriptionPrimary })).toBeNull()
  else expect(details.getByRole('meter', { name: en.subscriptionPrimary }).getAttribute('aria-valuenow')).toBe(String(remaining))
})

it('multiple accounts expand independently and keep their selection after reordered refreshes', async () => {
  const owner = new SubscriptionController(async () => {}); owners.push(owner)
  let accounts = [rawAccount, { ...rawAccount, accountKey: 'second-account', label: 'Secondary account' }]
  owner.connect({ availability: async () => 'active', activate: async () => 'active', invoke: async operation => operation === 'account-list' ? accounts : [] })
  render(<SubscriptionPage {...face(owner)} />)
  const firstName = `${en.subscriptionExpand} · ${rawAccount.label}`, secondName = `${en.subscriptionExpand} · Secondary account`
  const first = await screen.findByRole('button', { name: firstName })
  const second = screen.getByRole('button', { name: secondName })
  expect(first.getAttribute('aria-expanded')).toBe('false')
  expect(second.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText(en.subscriptionSynced)).toBeNull()
  expect(screen.getAllByRole('switch', { name: en.subscriptionEnabled })).toHaveLength(2)
  expect(screen.queryByRole('region', { name: 'Secondary account' })).toBeNull()
  expect(screen.queryByRole('region', { name: rawAccount.label })).toBeNull()
  fireEvent.click(second)
  expect(screen.getByRole('region', { name: 'Secondary account' })).toBeTruthy()
  expect(first.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(first)
  expect(screen.getByRole('region', { name: rawAccount.label })).toBeTruthy()
  fireEvent.click(first)
  expect(screen.queryByRole('region', { name: rawAccount.label })).toBeNull()
  accounts = accounts.toReversed()
  await act(async () => { await owner.ensure() })
  expect(screen.getByRole('button', { name: `${en.subscriptionExpand} · ${rawAccount.label}` }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('button', { name: `${en.subscriptionCollapse} · Secondary account` }).getAttribute('aria-expanded')).toBe('true')
})
