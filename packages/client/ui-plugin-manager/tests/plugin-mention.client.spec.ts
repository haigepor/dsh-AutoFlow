import { describe, expect, it, vi } from 'vitest'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { pluginMentionSource } from '../src/client/plugin-mention.ts'
import { en } from '../src/client/locales.ts'

const enabled: BundleInfo = {
  name: '@example/notes', enabled: true, installed: true, optional: false,
  removable: true, rows: [], overrides: [],
  meta: { title: { en: 'Notes', zh: '笔记' }, description: { en: 'Notes helper', zh: '笔记助手' }, icon: 'data:image/svg+xml;base64,PHN2Zy8+' },
}
const disabled: BundleInfo = { ...enabled, name: '@example/off', enabled: false }
const infrastructure: BundleInfo = { ...enabled, name: '@deepseek-ai/dsh-base' }
const session = { sessionId: 'session-1' as SessionId }
const request = { query: '', position: 'inline' as const, drilled: false, signal: new AbortController().signal }

describe('plugin @ source', () => {
  it('lists only enabled bundles and inserts a highlighted plugin chip', async () => {
    const list = vi.fn(async () => [disabled, infrastructure, enabled])
    const source = pluginMentionSource(list, value => typeof value === 'string' ? value : value?.en ?? '', key => en[key])
    const choices = await source.candidates(session, request)
    expect(choices).toEqual([expect.objectContaining({ name: '@example/notes', label: 'Notes', section: 'Enabled plugins' })])
    expect(choices[0]?.iconSize).toBe(24)
    expect(choices[0]?.value).toBe(enabled.meta?.icon)
    expect(await source.candidates(session, { ...request, quoted: true })).toEqual([])
    expect(source.onPick({ candidate: choices[0]!, session, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 1 } })).toEqual({
      insert: { source: 'plugin', ref: '@example/notes', label: 'Notes', appearance: 'plugin', artwork: enabled.meta?.icon, clipboardText: '@example/notes' },
    })
    expect(await source.codec?.serialize('@example/notes', request.signal)).toBe('@[Notes](dsh-plugin:@example/notes)')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('rejects a stale chip after its bundle is disabled', async () => {
    let bundles = [enabled]
    const source = pluginMentionSource(async () => bundles, value => typeof value === 'string' ? value : value?.en ?? '', key => en[key])
    await source.candidates(session, request)
    bundles = [disabled]
    await expect(source.codec?.serialize('@example/notes', request.signal)).rejects.toThrow(en.mentionUnavailable)
  })
})
