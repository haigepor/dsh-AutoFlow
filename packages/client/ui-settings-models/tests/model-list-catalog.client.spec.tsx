// @vitest-environment jsdom
/** Catalog reads preserve draft ownership and discard responses for a previous provider. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelListEditor } from '../src/client/ModelListEditor.tsx'
import type { ModelDiscoveryOutcome, ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('adds a custom model with all four shared efforts and High as its default', () => {
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[]} onChange={onChange} disabled={false} t={key => en[key]}
    probe={{ settingsNs: 'llm-pi-ai', provider: 'openai' }} onBusyChange={() => {}}
    operations={operations(() => Promise.resolve({ kind: 'found', models: [] }))}
  />)
  fireEvent.click(screen.getByRole('button', { name: en.addModel }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith([{
    id: '',
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
    defaultReasoningEffort: 'high',
  }])
})

it('adopts discovered custom models with all four shared efforts', async () => {
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[]} onChange={onChange} disabled={false} t={key => en[key]}
    probe={{ settingsNs: 'llm-pi-ai', baseURL: 'https://gateway.example/v1' }} onBusyChange={() => {}}
    operations={operations(() => Promise.resolve({ kind: 'found', models: [{ id: 'discovered-model' }] }))}
  />)
  fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
  const dialog = await screen.findByRole('dialog', { name: en.fetchTitle })
  fireEvent.click(within(dialog).getByRole('button', { name: en.fetchAdopt }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith([{
    id: 'discovered-model',
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
    defaultReasoningEffort: 'high',
  }])
})

it('edits a custom model default and preserves its protocol map while changing supported efforts', () => {
  const onChange = vi.fn()
  const model = { id: 'custom-thinking', input: ['text'], maxTokens: 4096,
    reasoningEfforts: { off: 'none', high: 'strong' }, compat: { thinkingFormat: 'qwen', supportsStore: false } }
  render(<ModelListEditor
    models={[model]} onChange={onChange} reasoningOptions={{
      levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], formats: ['openai', 'qwen'],
    }}
    probe={{ settingsNs: 'llm-pi-ai', baseURL: 'https://gateway.example/v1', api: 'openai-completions' }}
    disabled={false} t={key => en[key]} onBusyChange={() => {}}
    operations={operations(() => Promise.resolve({ kind: 'found', models: [] }))}
  />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelReasoning} 1` }))
  expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toMatchInlineSnapshot(`
    [
      "Low · low",
      "Medium · medium",
      "High · high",
      "Max · max",
      "Configure supported efforts",
    ]
  `)
  fireEvent.click(screen.getByRole('menuitem', { name: 'High · high' }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith([{ ...model, defaultReasoningEffort: 'high' }])
  onChange.mockClear()
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  const region = screen.getByRole('region', { name: `${en.reasoningSupported} 1` })
  fireEvent.click(within(region).getByRole('button', { name: 'Low · low' }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith([{ ...model, reasoningEfforts: { off: 'none', high: 'strong', low: 'low' } }])
})

it('offers common context capacities while keeping the field editable', () => {
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[{ id: 'capacity-model' }]} onChange={onChange} disabled={false} t={key => en[key]}
    probe={{ settingsNs: 'llm-pi-ai', provider: 'openai' }} onBusyChange={() => {}}
    operations={operations(() => Promise.resolve({ kind: 'found', models: [] }))}
  />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  fireEvent.click(screen.getByRole('button', { name: `${en.contextWindowMenu} 1` }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['128K', '256K', '512K', '1M', '2M', '4M'])
  fireEvent.click(screen.getByRole('menuitem', { name: '1M' }))
  expect(onChange).toHaveBeenCalledWith([{ id: 'capacity-model', contextWindow: 1_000_000 }])
})

function operations(discoverModels: ModelsOperations['discoverModels']): ModelsOperations {
  return {
    discoverModels,
    describeCredential: vi.fn(),
    storeCredential: vi.fn(),
    removeCredential: vi.fn(),
    writeSettings: vi.fn(),
  }
}

it('ignores a late catalog response after the provider changes', async () => {
  const oldCatalog = Promise.withResolvers<ModelDiscoveryOutcome>()
  const newCatalog = Promise.withResolvers<ModelDiscoveryOutcome>()
  const actions = operations(vi.fn()
    .mockReturnValueOnce(oldCatalog.promise)
    .mockReturnValueOnce(newCatalog.promise))
  const onChange = vi.fn()
  const props = {
    models: [{ id: 'm' }], onChange, operations: actions,
    disabled: false, t: (key: keyof typeof en) => en[key], onBusyChange: () => {},
  }
  const { rerender } = render(<ModelListEditor {...props} catalogProvider="old" probe={{ settingsNs: 'llm-pi-ai', provider: 'old' }} />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).disabled).toBe(true)
  rerender(<ModelListEditor {...props} catalogProvider="new" probe={{ settingsNs: 'llm-pi-ai', provider: 'new' }} />)
  await act(async () => { newCatalog.resolve({ kind: 'found', models: [{ id: 'm', inputModalities: ['text', 'image'] }] }) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(true)
  await act(async () => { oldCatalog.resolve({ kind: 'found', models: [{ id: 'm', inputModalities: ['text'] }] }) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
})

it('uses provider input defaults for a model absent from the installed catalog', async () => {
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[{ id: 'custom' }]} onChange={onChange} defaultInput={['image']} catalogProvider="openai"
    probe={{ settingsNs: 'llm-pi-ai', provider: 'openai' }} disabled={false} t={key => en[key]} onBusyChange={() => {}}
    operations={operations(() => Promise.resolve({ kind: 'found', models: [] }))}
  />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  const text = screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputText })
  await waitFor(() => { expect(text.disabled).toBe(false) })
  expect(text.checked).toBe(false)
  fireEvent.click(text)
  expect(onChange).toHaveBeenCalledWith([{ id: 'custom', input: ['text', 'image'] }])
})

it('inherits catalog inputs once an incomplete draft has a model id', async () => {
  const onChange = vi.fn()
  const props = {
    onChange, catalogProvider: 'openai',
    probe: { settingsNs: 'llm-pi-ai', provider: 'openai' },
    disabled: false, t: (key: keyof typeof en) => en[key], onBusyChange: () => {},
    operations: operations(() => Promise.resolve({
      kind: 'found', models: [{ id: 'vision', inputModalities: ['text', 'image'] }],
    })),
  }
  const { rerender } = render(<ModelListEditor {...props} models={[{}]} />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  const image = screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage })
  await waitFor(() => { expect(image.disabled).toBe(false) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputText }).checked).toBe(true)
  expect(image.checked).toBe(false)
  expect(onChange).not.toHaveBeenCalled()

  const id = screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`)
  expect(id.value).toBe('')
  fireEvent.change(id, { target: { value: 'vision' } })
  expect(onChange).toHaveBeenCalledExactlyOnceWith([{ id: 'vision' }])
  rerender(<ModelListEditor {...props} models={[{ id: 'vision' }]} />)
  expect(image.checked).toBe(true)
  expect(onChange).toHaveBeenCalledTimes(1)
})

it('restores inherited image input after a failed catalog read is retried manually', async () => {
  const discover = vi.fn<ModelsOperations['discoverModels']>()
    .mockResolvedValueOnce({ kind: 'refused', message: 'Catalog unavailable' })
    .mockResolvedValueOnce({ kind: 'found', models: [{ id: 'vision', inputModalities: ['text', 'image'] }] })
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[{ id: 'vision' }]} onChange={onChange} catalogProvider="openai"
    probe={{ settingsNs: 'llm-pi-ai', provider: 'openai' }} disabled={false} t={key => en[key]} onBusyChange={() => {}}
    operations={operations(discover)}
  />)
  await screen.findByText('Catalog unavailable')
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  const image = screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage })
  expect(image.checked).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
  const picker = await screen.findByRole('dialog', { name: en.fetchTitle })
  fireEvent.click(within(picker).getByRole('button', { name: en.cancel }))
  expect(image.checked).toBe(true)
  expect(screen.queryByText('Catalog unavailable')).toBeNull()
  expect(discover).toHaveBeenCalledTimes(2)
  expect(onChange).not.toHaveBeenCalled()
})
