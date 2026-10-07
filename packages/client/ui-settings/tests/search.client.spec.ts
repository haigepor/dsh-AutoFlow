import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SettingsSearch } from '../src/client/search.ts'

describe('SettingsSearch', () => {
  it('publishes locale-owned entries and removes them when the contributor unloads', () => {
    const catalog = new SettingsSearch(new Context())
    const listener = vi.fn()
    catalog.subscribe(listener)
    const empty = catalog.getSnapshot()
    let label = 'Font'
    const dispose = catalog.register({ id: 'appearance.font', sectionId: 'appearance-theme', label: () => label, target: '#appearance-font-heading' })
    const entries = catalog.getSnapshot()
    expect(entries).toHaveLength(1)
    expect(catalog.getSnapshot()).toBe(entries)
    label = '字体'
    expect(entries[0]?.label()).toBe('字体')
    dispose()
    expect(catalog.getSnapshot()).toEqual(empty)
    expect(listener).toHaveBeenCalledTimes(2)
    dispose()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('rejects duplicate setting ids without replacing a feature contribution', () => {
    const catalog = new SettingsSearch(new Context())
    const entry = { id: 'font', sectionId: 'appearance-theme', label: () => 'Font' }
    catalog.register(entry)
    expect(() => catalog.register(entry)).toThrow('font')
    expect(catalog.getSnapshot()).toHaveLength(1)
  })
})
