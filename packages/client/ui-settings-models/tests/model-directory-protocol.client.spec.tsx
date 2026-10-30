// @vitest-environment jsdom
/** The catalog names verified adapter/profile protocols without guessing from model identifiers. */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelsDirectory } from '../src/client/ModelsDirectory.tsx'
import { ModelsSkeleton } from '../src/client/ModelsSkeleton.tsx'
import type { ModelsSettingsState } from '../src/client/store.ts'
import { en, zh } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

function mount(settingsNs: string, api?: string, chinese = false) {
  const namespace: SettingsNamespaceView = { ns: settingsNs, schema: {}, value: {
    ...(api === undefined ? {} : { api }), models: [{ id: 'gpt-fixture', name: 'Fixture', api: 'ignored-model-protocol' }],
  }, applies: 'live', autoGenerate: false, secrets: [], revision: 0 }
  const state: ModelsSettingsState = { status: 'ready', error: null, credentialError: null, writable: true,
    namespaces: new Map([[settingsNs, namespace]]), rows: [{ entry: { provider: 'custom-route', displayName: 'GPT gateway',
      settingsNs, settingsPath: [], active: true }, configured: true, removable: false, apiKeyEnv: undefined, credential: undefined }] }
  const copy = chinese ? zh : en
  return render(<ModelsDirectory state={state} schema={settingsSchema} t={key => copy[key]}
    onEdit={() => {}} onRemove={() => {}} onRetry={() => {}} removable={() => false} />)
}

it.each([
  ['llm-deepseek', 'openai-responses', en.protocolDeepSeekMessages],
  ['llm-deepseek-account', undefined, en.protocolDeepSeekMessages],
  ['llm-deepseek-api-key', undefined, en.protocolDeepSeekMessages],
  ['codex-subscription', 'openai-completions', en.protocolOpenAiResponses],
  ['llm-pi-ai', 'openai-responses', en.protocolOpenAiResponses],
  ['llm-pi-ai', 'openai-completions', en.protocolOpenAiCompletions],
  ['llm-pi-ai', 'anthropic-messages', en.protocolAnthropicMessages],
  ['llm-pi-ai', 'future-api', 'future-api'],
  ['llm-pi-ai', undefined, en.directoryProtocolUnknown],
  ['llm-pi-ai', '', en.directoryProtocolUnknown],
  ['third-party', 'openai-responses', en.directoryProtocolUnknown],
] as const)('shows the actual protocol for %s / %s', (namespace, api, expected) => {
  mount(namespace, api)
  const table = screen.getByRole('table', { name: en.modelDirectory })
  expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual([
    en.directoryModel, en.provider, en.directoryProtocol, en.directoryCapabilities, en.contextWindow, en.modelActions,
  ])
  const row = within(table).getByRole('row', { name: /Fixture\s*gpt-fixture/ })
  expect(within(row).getAllByRole('cell')[2]?.textContent).toBe(expected)
})

it('localizes the new header and unknown protocol without exposing an internal fallback', () => {
  mount('llm-pi-ai', undefined, true)
  const table = screen.getByRole('table', { name: zh.modelDirectory })
  expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toMatchInlineSnapshot(`
    [
      "模型 / ID",
      "提供商",
      "模型协议",
      "输入与推理",
      "上下文窗口",
      "操作",
    ]
  `)
  expect(within(table).getByText(zh.directoryProtocolUnknown)).toBeTruthy()
})

it('reserves the same six columns in the initial catalog skeleton', () => {
  const { container } = render(<ModelsSkeleton />)
  expect(container.querySelectorAll('thead th')).toHaveLength(6)
  expect([...container.querySelectorAll('tbody tr')].map(row => row.querySelectorAll('td').length)).toEqual([6, 6, 6, 6])
})
