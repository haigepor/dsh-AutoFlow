// @vitest-environment jsdom
/** Built-in provider search, ordering, keyboard entry and selection. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProviderPicker } from '../src/client/ProviderPicker.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('orders common providers first and searches names and IDs without changing selection', () => {
  const onSelect = vi.fn()
  const onOpenChange = vi.fn()
  const props = {
    choices: [{ id: 'zebra', label: 'Zebra' }, { id: 'anthropic', label: 'Claude service' },
      { id: 'aws-bedrock', label: 'Amazon Bedrock' }, { id: 'openai', label: 'OpenAI' }, { id: 'deepseek', label: 'DeepSeek' }],
    selected: { id: 'aws-bedrock', label: 'Amazon Bedrock' }, open: true, disabled: false,
    onSelect, onOpenChange, t: (key: keyof typeof en) => en[key],
  }
  const view = render(<ProviderPicker {...props} />)
  const labels = (): (string | null)[] => screen.queryAllByRole('menuitem').map(item => item.textContent)
  expect(labels()).toEqual(['DeepSeek', 'OpenAI', 'Claude service', 'Amazon Bedrock', 'Zebra'])
  const search = screen.getByRole('searchbox', { name: en.providerSearch })
  fireEvent.change(search, { target: { value: ' ANTHROPIC ' } })
  expect(labels()).toEqual(['Claude service'])
  expect(onSelect).not.toHaveBeenCalled()
  fireEvent.change(search, { target: { value: 'missing-provider' } })
  expect(labels()).toEqual([])
  expect(screen.getByRole('status').textContent).toBe(en.providerSearchEmpty)
  fireEvent.change(search, { target: { value: 'bedrock' } })
  search.focus()
  fireEvent.keyDown(search, { key: 'Home' })
  expect(document.activeElement).toBe(search)
  fireEvent.keyDown(search, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Amazon Bedrock' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Amazon Bedrock' }))
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('aws-bedrock')
  expect(onOpenChange).toHaveBeenCalledWith(false)
  view.rerender(<ProviderPicker {...props} open={false} />)
  view.rerender(<ProviderPicker {...props} />)
  expect(screen.getByRole<HTMLInputElement>('searchbox', { name: en.providerSearch }).value).toBe('')
  expect(labels()).toHaveLength(5)
})
