// @vitest-environment jsdom
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { ModelCapabilities } from '../src/client/ModelCapabilities.tsx'
import { en } from '../src/client/locales.ts'
import type { DeepSeekModelDraft } from '../src/client/DeepSeekModelsEditor.tsx'

afterEach(cleanup)
function Editor({ id = 'gpt-6.1-sol', api = 'openai-responses' }: { id?: string; api?: string }) {
  const [model, setModel] = useState<DeepSeekModelDraft>({ id, hidden: 'preserved' })
  return <><ModelCapabilities model={model} api={api} disabled={false} t={key => en[key]} onChange={setModel} />
    <output data-testid="draft">{JSON.stringify(model)}</output></>
}
describe('model capabilities', () => {
  it('automatically checks a matched model and preserves a manual opt-out in the model draft', () => {
    render(<Editor />)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.nativeWebSearch }).checked).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: en.nativeWebSearch }))
    expect(JSON.parse(screen.getByTestId('draft').textContent ?? '')).toEqual({ id: 'gpt-6.1-sol', hidden: 'preserved', nativeWebSearch: false })
    fireEvent.click(screen.getByRole('button', { name: en.modelCapabilityAuto }))
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.nativeWebSearch }).checked).toBe(true)
    expect(JSON.parse(screen.getByTestId('draft').textContent ?? '')).not.toHaveProperty('nativeWebSearch')
  })
  it('leaves an unknown model unchecked and permits an explicit declaration', () => {
    render(<Editor id="private-model" />)
    const checkbox = screen.getByRole<HTMLInputElement>('checkbox', { name: en.nativeWebSearch })
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
  })
  it('disables unsupported protocols', () => {
    render(<Editor api="bedrock-converse-stream" />)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.nativeWebSearch }).disabled).toBe(true)
  })
})

it('restores a captured provider default without turning it into a manual override', () => {
  let draft: DeepSeekModelDraft = { id: 'private-model', nativeWebSearchDefault: true, nativeWebSearch: false }
  const { rerender } = render(<ModelCapabilities model={draft} api="openai-responses" disabled={false} t={key => en[key]}
    onChange={(next) => { draft = next }} />)
  fireEvent.click(screen.getByRole('button', { name: en.modelCapabilityAuto }))
  rerender(<ModelCapabilities model={draft} api="openai-responses" disabled={false} t={key => en[key]} onChange={() => {}} />)
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.nativeWebSearch }).checked).toBe(true)
  expect(draft).toEqual({ id: 'private-model', nativeWebSearchDefault: true })
})
