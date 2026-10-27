// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate, registerDomSnapshotSerializer } from '@deepseek-ai/dsh-client-test-runtime'
import { McpSettings } from '../src/client/McpSettings.tsx'
import { McpEditor } from '../src/client/McpEditor.tsx'
import { McpFeedback } from '../src/client/McpFeedback.tsx'
import { createMcpSettingsStore } from '../src/client/store.ts'
import type { McpSettingsProps, McpFeedbackProps } from '../src/client/contract.ts'
import type { McpServerDetail, McpServerDraft, McpServerList } from '../src/types.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
registerDomSnapshotSerializer()

const defaults: McpServerDraft = { serverName: '', transport: 'stdio', command: '', args: [], cwd: '', url: '', env: {}, headers: {}, toolCallTimeoutMs: 60000,
  reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }
const server: McpServerDetail = { id: 'include:demo' as McpServerDetail['id'], revision: 'first', serverName: 'demo', transport: 'streamable-http', enabled: true,
  phase: 'connected', tools: ['mcp__demo__ping'], readOnly: false, config: { ...defaults, serverName: 'demo', transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: null } } }

function fixture(servers: McpServerDetail[] = []) {
  const store = createMcpSettingsStore().create()
  const list: McpServerList = { servers, defaults }
  const operations = {
    refresh: vi.fn(), create: vi.fn(async () => true), update: vi.fn(async () => true), setEnabled: vi.fn(async () => true),
    restartServer: vi.fn(async () => true), restartApplication: vi.fn(async () => {}),
    saveJson: vi.fn<McpSettingsProps['saveJson']>(async () => ({ ok: true })),
  }
  const useResource = ((address: string) => ({ status: 'live', value: address.includes('mcp-server/') ? server : list })) as McpSettingsProps['useResource']
  const props = {
    ...operations, useResource, useStore: bindSnapshotSelector(store), actions: store.actions, t: makeTranslate(en),
  } as McpSettingsProps
  return { store, props, operations }
}

it('renders the MCP list, opens details, and invokes enablement and server restart', async () => {
  const { props, operations } = fixture([server])
  const { container } = render(<McpSettings {...props} />)
  expect(screen.getByText('Connected')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'How MCP configuration changes take effect' })).toBeTruthy()
  await expect(container).toMatchFileSnapshot('./fixtures/mcp-list.expected.html')
  fireEvent.click(screen.getByRole('switch', { name: 'Enable demo' }))
  expect(operations.setEnabled).toHaveBeenCalledWith(server.id, false)
  fireEvent.click(screen.getAllByRole('button', { name: 'Configure demo' })[0]!)
  expect(screen.getByDisplayValue('https://example.test/mcp')).toBeTruthy()
  expect(screen.getByPlaceholderText('Saved; enter a value to replace')).toBeTruthy()
  await expect(container).toMatchFileSnapshot('./fixtures/mcp-detail.expected.html')
  fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
  expect(operations.restartServer).toHaveBeenCalledWith(server.id)
})

it('adds a local server through the existing page and keeps a failed save draft visible', async () => {
  const { props, operations } = fixture()
  operations.create.mockResolvedValueOnce(false)
  render(<McpSettings {...props} />)
  fireEvent.click(screen.getAllByRole('button', { name: 'Add MCP' })[0]!)
  const nameField = screen.getByRole('textbox', { name: /^Server name/ }) as HTMLInputElement
  const pattern = new RegExp(`^(?:${nameField.pattern})$`, 'v')
  expect(pattern.test('my-server_1')).toBe(true)
  expect(pattern.test('invalid name')).toBe(false)
  fireEvent.change(screen.getByRole('textbox', { name: /^Server name/ }), { target: { value: 'local' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), { target: { value: 'node' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Arguments (one per line)' }), { target: { value: 'server.mjs\n--verbose' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save and apply' }))
  await waitFor(() => { expect(operations.create).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'local', command: 'node', args: ['server.mjs', '--verbose'] }), true) })
  expect(screen.getByDisplayValue('local')).toBeTruthy()
})

it('retains saved secrets and the editor revision while live status updates', async () => {
  const save = vi.fn(async () => true)
  const base = { initial: server.config, revision: 'first', creating: false, readOnly: false, busy: false, onSave: save, onCancel: vi.fn(), t: makeTranslate(en) }
  const { rerender } = render(<McpEditor {...base} />)
  fireEvent.change(screen.getByRole('textbox', { name: /^Server name/ }), { target: { value: 'edited' } })
  rerender(<McpEditor {...base} revision="second" />)
  fireEvent.click(screen.getByRole('button', { name: 'Save and apply' }))
  await waitFor(() => { expect(save).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'edited', headers: { Authorization: null } }), true, 'first') })
})

it('requires an explicit restart confirmation and hosts feedback outside the settings page', () => {
  const { props, store, operations } = fixture()
  store.actions.confirmRestart(true)
  render(<McpFeedback {...props as McpFeedbackProps} />)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(operations.restartApplication).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Restart now' }))
  expect(operations.restartApplication).toHaveBeenCalledOnce()
})

it('shares model-style click help and the themed transport menu, and animates advanced disclosure', () => {
  const { props } = fixture()
  render(<McpSettings {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'How MCP configuration changes take effect' }))
  const help = screen.getByRole('dialog', { name: 'Connect external tools and data' })
  fireEvent.click(within(help).getByRole('button', { name: 'Close' }))
  fireEvent.click(screen.getAllByRole('button', { name: 'Add MCP' })[0]!)
  fireEvent.click(screen.getByRole('button', { name: 'Transport' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remote service' }))
  expect(screen.getByRole('textbox', { name: 'Server URL' })).toBeTruthy()
  expect(screen.queryByRole('spinbutton', { name: 'Call timeout (ms)' })).toBeNull()
  const advanced = screen.getByRole('button', { name: 'Advanced settings' })
  fireEvent.click(advanced)
  expect(advanced.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('spinbutton', { name: 'Call timeout (ms)' })).toBeTruthy()
  fireEvent.click(advanced)
  expect(screen.queryByRole('spinbutton', { name: 'Call timeout (ms)' })).toBeNull()
})

it('opens redacted highlighted JSON and keeps failed edits available for correction', async () => {
  const { props, operations } = fixture([server])
  operations.saveJson.mockResolvedValueOnce({ ok: false, error: 'invalid-json', partial: false })
  render(<McpSettings {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Import JSON configuration' }))
  const dialog = screen.getByRole('dialog', { name: 'MCP JSON configuration' })
  const source = within(dialog).getByRole('textbox', { name: 'JSON configuration source' }) as HTMLTextAreaElement
  expect(source.value).toContain('"Authorization": null')
  fireEvent.change(source, { target: { value: '{' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save and apply' }))
  await waitFor(() => { expect(within(dialog).getByRole('alert').textContent).toContain('Invalid JSON') })
  expect(source.value).toBe('{')
  fireEvent.change(source, { target: { value: '{"mcpServers":{}}' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Format' }))
  expect(source.value).toContain('\n')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reload configuration' }))
  expect(within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: 'JSON configuration source' }).value)
    .toContain('"Authorization": null')
})

it('reserves real row geometry while loading without exposing placeholder controls', () => {
  const { props } = fixture()
  const pending = (() => ({ status: 'loading', value: undefined, failure: undefined })) as McpSettingsProps['useResource']
  const { container } = render(<McpSettings {...props} useResource={pending} />)
  expect(screen.getByRole('status', { name: 'Loading MCP configuration' })).toBeTruthy()
  expect(container.querySelector('[data-mcp-skeleton="list"]')).toBeTruthy()
  expect(screen.queryByRole('switch')).toBeNull()
})
