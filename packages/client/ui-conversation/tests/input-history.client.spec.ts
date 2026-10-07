// @vitest-environment jsdom
// The per-workspace input-history store: bucket roundtrip and MRU dedupe,
// the three caps (per-scope 200, 20 scopes, 1MB serialized), entry
// truncation, localStorage persistence and reload validation, and the
// memory fallbacks when storage is unavailable, throwing, or over quota.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { historyScopeOf, list, remember, resetInputHistoryForTests } from '../src/client/input/history.ts'

const SCOPE = 'C:/proj/a'
const SID = 's1' as SessionId
const KEY = 'dsh.conversation.input-history.v1'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetInputHistoryForTests()
})

describe('input history store', () => {
  it('roundtrips newest-first and moves a re-membered entry to the front', () => {
    remember('one', SCOPE)
    remember('two', SCOPE)
    remember('three', SCOPE)
    expect(list(SCOPE)).toEqual(['three', 'two', 'one'])
    remember('one', SCOPE)
    expect(list(SCOPE)).toEqual(['one', 'three', 'two'])
  })

  it('keeps buckets independent per scope', () => {
    remember('a', 'C:/proj/a')
    remember('b', 'C:/proj/b')
    expect(list('C:/proj/a')).toEqual(['a'])
    expect(list('C:/proj/b')).toEqual(['b'])
    expect(list('C:/proj/missing')).toEqual([])
  })

  it('caps a bucket at 200 entries, shedding the oldest', () => {
    for (let i = 0; i < 205; i += 1) remember(`entry-${i}`, SCOPE)
    const entries = list(SCOPE)
    expect(entries.length).toBe(200)
    expect(entries[0]).toBe('entry-204')
    expect(entries.at(-1)).toBe('entry-5')
  })

  it('truncates an entry to 8000 characters', () => {
    remember('x'.repeat(8100), SCOPE)
    expect(list(SCOPE)[0]?.length).toBe(8000)
  })

  it('evicts the least-recently-used scope past 20 scopes', () => {
    for (let i = 0; i <= 20; i += 1) remember(`s${i}`, `C:/proj/s${i}`)
    expect(list('C:/proj/s0')).toEqual([])
    expect(list('C:/proj/s20')).toEqual(['s20'])
  })

  it('re-membering a scope protects it from LRU eviction', () => {
    for (let i = 0; i <= 20; i += 1) remember(`s${i}`, `C:/proj/s${i}`)
    remember('touched', 'C:/proj/s0')
    expect(list('C:/proj/s0')).toEqual(['touched'])
    expect(list('C:/proj/s1')).toEqual([])
  })

  it('sheds whole least-recently-used scopes while over the 1MB budget', () => {
    // One entry tops out at 8000 characters, so the budget is filled with
    // many: 70 × ~8004 bytes ≈ 560KB per scope, two scopes over the line.
    for (let i = 0; i < 70; i += 1) remember(`y${'y'.repeat(7990)}-${i}`, 'C:/proj/big1')
    for (let i = 0; i < 70; i += 1) remember(`y${'y'.repeat(7990)}-${i}`, 'C:/proj/big2')
    expect(list('C:/proj/big1')).toEqual([])
    expect(list('C:/proj/big2').length).toBe(70)
    expect(list('C:/proj/big2')[0]?.endsWith('-69')).toBe(true)
  })

  it("sheds the sole scope's oldest entries while it alone exceeds the budget", () => {
    for (let i = 0; i < 130; i += 1) remember(`z${'z'.repeat(7990)}-${i}`, SCOPE)
    const entries = list(SCOPE)
    expect(entries.length).toBeLessThan(130)
    expect(entries[0]?.endsWith('-129')).toBe(true)
    expect(entries.length).toBeGreaterThanOrEqual(100)
  })

  it('persists to localStorage and reloads into a fresh mirror', () => {
    remember('persisted', SCOPE)
    const raw = window.localStorage.getItem(KEY)
    expect(raw).toContain('persisted')
    // Same storage, fresh document: the mirror reloads on first access.
    resetInputHistoryForTests(true)
    expect(list(SCOPE)).toEqual(['persisted'])
  })

  it('caps the loaded buckets at 20 scopes and 200 entries', () => {
    const scopes: Record<string, string[]> = {}
    for (let i = 0; i < 25; i += 1) scopes[`C:/proj/s${i}`] = Array.from({ length: 210 }, (_, j) => `e${j}`)
    window.localStorage.setItem(KEY, JSON.stringify({ order: Object.keys(scopes), scopes }))
    resetInputHistoryForTests(true)
    expect(list('C:/proj/s0')).toEqual([])
    expect(list('C:/proj/s5').length).toBe(200)
    expect(list('C:/proj/s24').length).toBe(200)
  })

  it('ignores corrupt, malformed, and invalid persisted payloads', () => {
    for (const raw of ['not json', '42', 'null', '[]', '{}', JSON.stringify({ scopes: null }), JSON.stringify({ scopes: [] }), JSON.stringify({ scopes: { a: 'nope' } }), JSON.stringify({ scopes: { a: [] } })]) {
      window.localStorage.setItem(KEY, raw)
      resetInputHistoryForTests(true)
      expect(list('a')).toEqual([])
    }
    window.localStorage.setItem(KEY, JSON.stringify({ scopes: { a: [1, 'kept', null] } }))
    resetInputHistoryForTests(true)
    expect(list('a')).toEqual(['kept'])
  })

  it('keeps the memory mirror when localStorage is absent', () => {
    vi.stubGlobal('localStorage', undefined)
    remember('memory-only', SCOPE)
    expect(list(SCOPE)).toEqual(['memory-only'])
  })

  it('keeps the memory mirror when touching localStorage throws', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    remember('private-mode', SCOPE)
    expect(list(SCOPE)).toEqual(['private-mode'])
  })

  it('survives a quota-exceeded write', () => {
    const store = window.localStorage
    vi.stubGlobal('localStorage', {
      getItem: () => store.getItem(KEY),
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError') },
      removeItem: () => { store.removeItem(KEY) },
    })
    remember('over-quota', SCOPE)
    expect(list(SCOPE)).toEqual(['over-quota'])
  })

  it('derives the scope from the workspace cwd, falling back to the session id', () => {
    expect(historyScopeOf('C:/proj/a', SID)).toBe('C:/proj/a')
    expect(historyScopeOf(undefined, SID)).toBe('s1')
    expect(historyScopeOf('', SID)).toBe('s1')
  })

  it('clears storage and the mirror on the default reset', () => {
    remember('gone', SCOPE)
    resetInputHistoryForTests()
    expect(list(SCOPE)).toEqual([])
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it('keeps recall available when storage reads throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    expect(() => { remember('memory draft', SCOPE) }).not.toThrow()
    expect(list(SCOPE)).toEqual(['memory draft'])
  })

  it('enforces entry and serialized limits when loading persisted history', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ scopes: {
      [SCOPE]: Array.from({ length: 200 }, (_, index) => `${index}${'x'.repeat(9000)}`),
    } }))
    resetInputHistoryForTests(true)
    const entries = list(SCOPE)
    expect(entries.every(entry => entry.length <= 8000)).toBe(true)
    expect(JSON.stringify({ order: [SCOPE], scopes: { [SCOPE]: entries } }).length).toBeLessThanOrEqual(1_000_000)
  })

  it('restores explicit LRU order for numeric workspace keys', () => {
    for (let index = 0; index < 20; index += 1) remember(`entry ${index}`, String(index))
    remember('recent zero', '0')
    resetInputHistoryForTests(true)
    remember('next', '20')
    expect(list('0')).toEqual(['recent zero', 'entry 0'])
    expect(list('1')).toEqual([])
  })

  it('ignores invalid order members and keys absent from persisted buckets', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ order: [false, 'missing', 'a', 'a'], scopes: { a: ['kept'] } }))
    resetInputHistoryForTests(true)
    expect(list('a')).toEqual(['kept'])
  })

  it('drops an oversized scope key when emptying its entries cannot satisfy the budget', () => {
    const scope = 's'.repeat(1_000_000)
    remember('draft', scope)
    expect(list(scope)).toEqual([])
  })

  it('resets the mirror when storage removal is denied', () => {
    remember('old', SCOPE)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('SecurityError') })
    expect(() => { resetInputHistoryForTests() }).not.toThrow()
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null)
    expect(list(SCOPE)).toEqual([])
  })
})
