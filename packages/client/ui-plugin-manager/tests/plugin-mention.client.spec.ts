import { describe, expect, it, vi } from 'vitest'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { pluginMentionSource } from '../src/client/plugin-mention.ts'
import { en } from '../src/client/locales.ts'

const enabled: BundleInfo = {
  name: '@example/notes', enabled: true, installed: true, updatable: false, optional: false,
  official: false, availability: 'profile',
  removable: true, rows: [], overrides: [],
  meta: { title: { en: 'Notes', zh: '笔记' }, description: { en: 'Notes helper', zh: '笔记助手' }, icon: 'data:image/svg+xml;base64,PHN2Zy8+' },
}
const disabled: BundleInfo = { ...enabled, name: '@example/off', enabled: false }
const infrastructure: BundleInfo = { ...enabled, name: '@deepseek-ai/dsh-base' }
const session = { sessionId: 'session-1' as SessionId }
const request = { query: '', position: 'inline' as const, drilled: false, signal: new AbortController().signal }

describe('plugin @ source', () => {
  it('lists available bundles, marks disabled ones, and inserts a highlighted plugin chip', async () => {
    const list = vi.fn(async () => [disabled, infrastructure, enabled])
    const source = pluginMentionSource(list, value => typeof value === 'string' ? value : value?.en ?? '', key => en[key])
    const choices = await source.candidates(session, request)
    expect(choices).toEqual([
      expect.objectContaining({ name: '@example/off', label: 'Notes', section: 'Plugins', description: en.mentionDisabled }),
      expect.objectContaining({ name: '@example/notes', label: 'Notes', section: 'Plugins' }),
    ])
    expect(choices[0]?.iconSize).toBe(24)
    expect(choices[0]?.value).toBe(enabled.meta?.icon)
    expect(source.order).toBeLessThan(0)
    expect(await source.candidates(session, { ...request, quoted: true })).toEqual([])
    expect(source.onPick({ candidate: choices[0]!, session, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 1 } })).toEqual({
      insert: { source: 'plugin', ref: '@example/off', label: 'Notes', appearance: 'plugin', artwork: enabled.meta?.icon, clipboardText: '@example/off' },
    })
    expect(await source.codec?.serialize('@example/notes', request.signal)).toBe('@[Notes](dsh-plugin:@example/notes)')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('filters plugins by package name or localized title and hides them during directory browsing', async () => {
    const source = pluginMentionSource(async () => [enabled], value => typeof value === 'string' ? value : value?.zh ?? '', key => en[key])
    expect(await source.candidates(session, { ...request, query: 'NOTES' })).toHaveLength(1)
    expect(await source.candidates(session, { ...request, query: '笔记' })).toHaveLength(1)
    expect(await source.candidates(session, { ...request, query: 'missing' })).toEqual([])
    expect(await source.candidates(session, { ...request, drilled: true })).toEqual([])
  })

  it('rejects a stale chip after its bundle is disabled', async () => {
    let bundles = [enabled]
    const source = pluginMentionSource(async () => bundles, value => typeof value === 'string' ? value : value?.en ?? '', key => en[key])
    await source.candidates(session, request)
    bundles = [disabled]
    await expect(source.codec?.serialize('@example/notes', request.signal)).rejects.toThrow(en.mentionUnavailable)
  })

  it('prepares the selected plugin in its Session and waits before serializing submission', async () => {
    const gate = Promise.withResolvers<undefined>()
    const picked = vi.fn(), prepare = vi.fn(() => gate.promise)
    const source = pluginMentionSource(async () => [enabled], value => typeof value === 'string' ? value : value?.en ?? '', key => en[key], { picked, prepare })
    const choices = await source.candidates(session, request)
    source.onPick({ candidate: choices[0]!, session, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 1 } })
    expect(picked).toHaveBeenCalledExactlyOnceWith(session, enabled.name)
    const serializing = source.codec!.serialize(enabled.name, request.signal, session)
    await vi.waitFor(() => { expect(prepare).toHaveBeenCalledExactlyOnceWith(session, enabled.name, request.signal) })
    gate.resolve(undefined)
    await expect(serializing).resolves.toBe('@[Notes](dsh-plugin:@example/notes)')
  })

  it('blocks submission when plugin preparation refuses the Session', async () => {
    const source = pluginMentionSource(async () => [enabled], value => typeof value === 'string' ? value : value?.en ?? '', key => en[key], {
      picked: vi.fn(), prepare: () => Promise.reject(new Error('Preset unavailable')),
    })
    await expect(source.codec!.serialize(enabled.name, request.signal, session)).rejects.toThrow('Preset unavailable')
  })
})
