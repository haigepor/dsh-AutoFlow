// @vitest-environment jsdom
/** Model-level capability edits preserve inherited and custom protocol values. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ModelReasoningCapabilities, ModelReasoningDefault } from '../src/client/ModelReasoningCapabilities.tsx'
import { modelReasoningOptions, validateModelReasoning } from '../src/client/model-reasoning.ts'
import { validateDeepSeekModels } from '../src/client/DeepSeekModelsEditor.tsx'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

it('reads adapter identifiers and formats from the serialized schema, including deployment restrictions', () => {
  const schema = z.object({ providers: z.dict(z.object({ models: z.array(z.object({
    defaultReasoningEffort: z.union(['off', 'low', 'extended']),
    compat: z.object({ thinkingFormat: z.union(['custom-format']) }),
  })) })) })
  const namespace: SettingsNamespaceView = {
    ns: 'test', schema: JSON.parse(JSON.stringify(schema.toJSON())) as JsonValue,
    value: {}, base: {}, user: {}, revision: 0, secrets: [], autoGenerate: true, applies: 'live',
  }
  expect(modelReasoningOptions(namespace, settingsSchema, ['providers', 'test'], {})).toMatchObject({
    levels: ['off', 'low', 'extended'], formats: ['custom-format'],
  })
  expect(modelReasoningOptions(namespace, settingsSchema, ['providers', 'test'], { thinking: 'disabled' }).levels).toEqual(['off'])
})

it('enables an adapter-supported catalog level and preserves inherited wire spellings', () => {
  const onChange = vi.fn()
  const model = { id: 'catalog', compat: { supportsStore: false } }
  render(<ModelReasoningCapabilities model={model} direct={false} position={1} disabled={false}
    options={{ levels: ['off', 'low', 'high'], formats: [], inheritedMapping: { off: null, low: 'small', high: 'large' } }}
    inherited={{ efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }] }}
    onChange={onChange} t={key => en[key]} />)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Low · low' }).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Low · low' }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...model, reasoningEfforts: { off: null, high: 'large', low: 'small' } })
})

it('shows the five shared levels as toggles and lets the user add schema extensions', () => {
  const onChange = vi.fn()
  render(<ModelReasoningCapabilities model={{ id: 'custom' }} direct={false} position={1} disabled={false}
    options={{ levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], formats: [] }}
    onChange={onChange} t={key => en[key]} />)
  for (const level of ['Off · off', 'Low · low', 'Medium · medium', 'High · high', 'Max · max']) {
    expect(screen.getByRole<HTMLButtonElement>('button', { name: level }).disabled).toBe(false)
  }
  fireEvent.click(screen.getByRole('button', { name: 'High · high' }))
  expect(onChange).toHaveBeenCalledWith({ id: 'custom', reasoningEfforts: { high: 'high' } })
  fireEvent.click(screen.getByRole('button', { name: `${en.reasoningAddLevel} 1` }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Minimal · minimal' }))
  expect(onChange).toHaveBeenLastCalledWith({ id: 'custom', reasoningEfforts: { minimal: 'minimal' } })
})

it('shows high as the implicit default when a model supports it', () => {
  const onChange = vi.fn()
  render(<ModelReasoningDefault model={{ id: 'custom' }} direct={false} position={1} disabled={false}
    options={{ levels: ['off', 'low', 'medium', 'high', 'max'], formats: [] }} onChange={onChange}
    inherited={{ efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }] }}
    onConfigure={() => {}} t={key => en[key]} />)
  expect(screen.getByRole('button', { name: `${en.modelReasoning} 1` }).textContent).toContain('High · high')
})

it('keeps minimal and xhigh out of the common controls until the user adds one', () => {
  const onChange = vi.fn()
  const model = { id: 'custom', reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' } }
  render(<ModelReasoningCapabilities model={model} direct={false} position={1} disabled={false}
    options={{ levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], formats: [] }}
    onChange={onChange} t={key => en[key]} />)
  expect(screen.queryByRole('button', { name: 'Minimal · minimal' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: `${en.reasoningAddLevel} 1` }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Minimal · minimal', 'Extra high · xhigh'])
  fireEvent.click(screen.getByRole('menuitem', { name: 'Minimal · minimal' }))
  expect(onChange).toHaveBeenCalledWith({ ...model, reasoningEfforts: { ...model.reasoningEfforts, minimal: 'minimal' } })
})

it('keeps a removed default error visible while capability levels toggle directly', () => {
  const onChange = vi.fn()
  const model = { id: 'm', reasoningEfforts: ['off', 'low'], defaultReasoningEffort: 'high', description: 'keep' }
  render(<ModelReasoningCapabilities model={model} direct position={1} disabled={false}
    options={{ levels: ['off', 'low', 'high', 'max'], formats: [] }} onChange={onChange} t={key => en[key]} />)
  expect(screen.getByRole('alert').textContent).toBe(en.reasoningDefaultInvalid)
  expect(validateDeepSeekModels([model])).toEqual({ index: 0, key: 'reasoningDefaultInvalid' })
  expect(screen.queryByRole('button', { name: 'Inherit' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Low · low' }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...model, reasoningEfforts: ['off'] })
})

it('rejects empty subsets and invalid wire mappings while allowing an explicit non-reasoning model', () => {
  expect(validateModelReasoning({ reasoningEfforts: [] }, true)).toBe('reasoningNeedsLevel')
  expect(validateModelReasoning({ reasoningEfforts: { off: null } }, false)).toBe('reasoningNeedsLevel')
  expect(validateModelReasoning({ reasoningEfforts: { high: null } }, false)).toBe('reasoningWireInvalid')
  expect(validateModelReasoning({ reasoningEfforts: false }, false)).toBeUndefined()
  expect(validateModelReasoning({ reasoningEfforts: false, defaultReasoningEffort: 'high' }, false)).toBe('reasoningDefaultInvalid')
})
