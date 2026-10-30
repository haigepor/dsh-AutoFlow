// @vitest-environment jsdom
/** Batch choices remain local until one catalog save, without replacing unrelated models. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SubscriptionModels } from '../src/client/SubscriptionModels.tsx'
import type { SubscriptionCatalog, SubscriptionCatalogEntry } from '../src/client/subscription-api.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('saves a manually selected native-search capability with the edited subscription model', async () => {
  const { save } = mount()
  fireEvent.click(within(screen.getByRole('table', { name: en.subscriptionConfiguredModels })).getByRole('button', { name: `${en.subscriptionEditModel} · Existing` }))
  fireEvent.click(screen.getByRole('checkbox', { name: en.nativeWebSearch }))
  fireEvent.click(saveButton())
  expect(save).toHaveBeenCalledWith([{ kind: 'text', id: 'existing', name: 'Existing', nativeWebSearch: true }], undefined)
})

type Props = ComponentProps<typeof SubscriptionModels>
const existing: SubscriptionCatalogEntry = { kind: 'text', id: 'existing', name: 'Existing' }
const catalog: SubscriptionCatalog = { revision: 4, entries: [existing], defaultImageModel: 'gpt-image-fixture', candidates: [
  { id: 'gpt-a', name: 'Alpha' }, { id: 'gpt-b', name: 'Beta' }, { id: 'gpt-c', name: 'Gamma' }, { id: 'existing', name: 'Existing' },
] }

function mount() {
  const save = vi.fn<Props['saveCatalog']>(async () => true), close = vi.fn()
  const props: Props = { catalog, catalogStatus: 'ready', catalogError: null, busy: false, onClose: close,
    loadCatalog: async () => {}, saveCatalog: save, t: key => en[key] }
  return { ...render(<SubscriptionModels {...props} />), save, close, props }
}

async function select(...names: string[]) {
  fireEvent.click(screen.getByRole('button', { name: en.subscriptionModelId }))
  for (const name of names) fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(name) }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.subscriptionFinishSelection }))
}

const pending = () => within(screen.getByRole('table', { name: en.subscriptionPendingModels }))
const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: en.subscriptionSaveAllModels })

it('selects and renames several text models, then writes one combined catalog', async () => {
  const { save, close } = mount()
  await select('Alpha', 'Beta')
  expect(save).not.toHaveBeenCalled()
  expect(pending().getAllByRole('columnheader').map(cell => cell.textContent)).toEqual([en.directoryModel, en.subscriptionModelKind, en.modelActions])
  fireEvent.change(pending().getByRole('textbox', { name: `${en.subscriptionModelName} · gpt-a` }), { target: { value: 'My Alpha' } })
  await act(async () => { fireEvent.click(saveButton()) })
  expect(save).toHaveBeenCalledExactlyOnceWith([existing,
    { kind: 'text', id: 'gpt-a', name: 'My Alpha' }, { kind: 'text', id: 'gpt-b', name: 'Beta' }], undefined)
  expect(close).toHaveBeenCalledOnce()
})

it('selects all available text models without duplicating configured or selected rows', async () => {
  const { save } = mount()
  fireEvent.click(screen.getByRole('button', { name: en.subscriptionModelId }))
  fireEvent.click(await screen.findByRole('menuitem', { name: en.subscriptionSelectAllModels }))
  expect(pending().getAllByRole('textbox')).toHaveLength(3)
  expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: en.subscriptionSelectAllModels }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('menuitem', { name: en.subscriptionClearModels }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.subscriptionFinishSelection }))
  expect(screen.queryByRole('table', { name: en.subscriptionPendingModels })).toBeNull()
  expect(saveButton().disabled).toBe(true)
  expect(save).not.toHaveBeenCalled()
})

it('queues several image models and applies only the explicitly selected batch default', async () => {
  const { save } = mount()
  fireEvent.click(screen.getByRole('tab', { name: en.subscriptionImageModel }))
  fireEvent.change(screen.getByRole('textbox', { name: en.subscriptionModelId }), { target: { value: 'image-a' } })
  fireEvent.change(screen.getByRole('textbox', { name: en.subscriptionModelName }), { target: { value: 'Image A' } })
  fireEvent.click(screen.getByRole('switch', { name: en.subscriptionUseImageDefault }))
  fireEvent.click(screen.getByRole('button', { name: en.subscriptionQueueModel }))
  fireEvent.change(screen.getByRole('textbox', { name: en.subscriptionModelId }), { target: { value: 'image-b' } })
  fireEvent.change(screen.getByRole('textbox', { name: en.subscriptionModelName }), { target: { value: 'Image B' } })
  fireEvent.click(screen.getByRole('button', { name: en.subscriptionQueueModel }))
  expect(save).not.toHaveBeenCalled()
  expect(pending().getAllByRole('textbox')).toHaveLength(2)
  expect(pending().getAllByText(en.subscriptionDefaultImageTag)).toHaveLength(1)
  await act(async () => { fireEvent.click(saveButton()) })
  expect(save).toHaveBeenCalledExactlyOnceWith([existing,
    { kind: 'image', id: 'image-a', name: 'Image A' }, { kind: 'image', id: 'image-b', name: 'Image B' }], 'image-a')
})

it('does not add the prefilled image model when only switching tabs during a text batch', async () => {
  const { save } = mount()
  await select('Alpha')
  fireEvent.click(screen.getByRole('tab', { name: en.subscriptionImageModel }))
  await act(async () => { fireEvent.click(saveButton()) })
  expect(save).toHaveBeenCalledExactlyOnceWith([existing, { kind: 'text', id: 'gpt-a', name: 'Alpha' }], undefined)
})

it('requires every pending name and allows removing a pending row without writing', async () => {
  const { save } = mount()
  await select('Alpha', 'Beta')
  fireEvent.change(pending().getByRole('textbox', { name: `${en.subscriptionModelName} · gpt-a` }), { target: { value: '   ' } })
  expect(saveButton().disabled).toBe(true)
  fireEvent.click(pending().getAllByRole('button')[0]!)
  expect(saveButton().disabled).toBe(false)
  expect(save).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(saveButton()) })
  expect(save).toHaveBeenCalledExactlyOnceWith([existing, { kind: 'text', id: 'gpt-b', name: 'Beta' }], undefined)
})

it('keeps the complete batch after a rejected save and retries the same entries', async () => {
  const { save, close } = mount()
  save.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  await select('Alpha', 'Beta')
  await act(async () => { fireEvent.click(saveButton()) })
  expect(close).not.toHaveBeenCalled()
  expect(pending().getAllByRole('textbox')).toHaveLength(2)
  await act(async () => { fireEvent.click(saveButton()) })
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0])
  expect(close).toHaveBeenCalledOnce()
})

it('preserves pending additions when also editing an existing model', async () => {
  const { save } = mount()
  await select('Alpha')
  fireEvent.click(within(screen.getByRole('table', { name: en.subscriptionConfiguredModels })).getByRole('button', { name: `${en.subscriptionEditModel} · Existing` }))
  fireEvent.change(screen.getByRole('textbox', { name: en.subscriptionModelName }), { target: { value: 'Renamed existing' } })
  await act(async () => { fireEvent.click(saveButton()) })
  expect(save).toHaveBeenCalledExactlyOnceWith([
    { kind: 'text', id: 'gpt-a', name: 'Alpha' }, { ...existing, name: 'Renamed existing' }], undefined)
})

it('retains a concurrent model instead of overwriting it with a conflicting pending row', async () => {
  const { save, props, rerender } = mount()
  await select('Alpha', 'Beta')
  const external: SubscriptionCatalogEntry = { kind: 'text', id: 'gpt-a', name: 'External Alpha' }
  rerender(<SubscriptionModels {...props} catalog={{ ...catalog, revision: 5, entries: [existing, external] }} />)
  expect(saveButton().disabled).toBe(true)
  expect(screen.getByRole('alert').textContent).toBe(en.subscriptionModelDuplicate)
  fireEvent.click(pending().getByRole('button', { name: `${en.subscriptionRemoveModel} · Alpha` }))
  await act(async () => { fireEvent.click(saveButton()) })
  expect(save).toHaveBeenCalledExactlyOnceWith([existing, external, { kind: 'text', id: 'gpt-b', name: 'Beta' }], undefined)
})

it('discards local selections when cancelling without a catalog write', async () => {
  const { save, close } = mount()
  await select('Alpha', 'Beta')
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(save).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})
