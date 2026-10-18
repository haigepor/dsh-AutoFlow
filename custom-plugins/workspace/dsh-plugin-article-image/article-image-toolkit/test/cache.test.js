import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResponseCache, cacheIsFresh, freshnessSeconds, heuristicFreshness, isStorable } from '../src/cache.js'

describe('freshnessSeconds', () => {
  it('reads max-age in seconds', () => {
    expect(freshnessSeconds('public, max-age=600')).toBe(600)
  })

  it('treats no-store and no-cache as uncacheable', () => {
    expect(freshnessSeconds('no-store')).toBe(0)
    expect(freshnessSeconds('private, no-cache, max-age=600')).toBe(0)
  })

  it('returns zero without a usable directive', () => {
    expect(freshnessSeconds(undefined)).toBe(0)
    expect(freshnessSeconds('public')).toBe(0)
  })
})

describe('heuristicFreshness', () => {
  const now = Date.parse('2026-10-17T12:00:00Z')

  it('derives a tenth of the age since Last-Modified', () => {
    // 一小时的年龄给出 360 秒，正是一小时的一成。
    expect(heuristicFreshness({ 'last-modified': '2026-10-17T11:00:00Z' }, now)).toBe(360)
  })

  it('caps the derived freshness', () => {
    expect(heuristicFreshness({ 'last-modified': '2025-01-01T00:00:00Z' }, now)).toBe(600)
  })

  it('refuses to apply a heuristic when the response forbids reuse', () => {
    expect(heuristicFreshness({ 'cache-control': 'no-store', 'last-modified': '2026-10-17T11:00:00Z' }, now)).toBe(0)
    expect(heuristicFreshness({ 'cache-control': 'no-cache', 'last-modified': '2026-10-17T11:00:00Z' }, now)).toBe(0)
  })

  it('returns zero without a usable Last-Modified', () => {
    expect(heuristicFreshness({}, now)).toBe(0)
    expect(heuristicFreshness({ 'last-modified': 'not a date' }, now)).toBe(0)
    expect(heuristicFreshness({ 'last-modified': '2026-10-18T00:00:00Z' }, now)).toBe(0)
  })
})

describe('isStorable', () => {
  it('stores a response with positive max-age, an ETag or a Last-Modified', () => {
    expect(isStorable({ 'cache-control': 'public, max-age=300' })).toBe(true)
    expect(isStorable({ etag: 'W/"v1"' })).toBe(true)
    expect(isStorable({ 'last-modified': 'Fri, 16 Oct 2026 20:44:35 GMT' })).toBe(true)
  })

  it('refuses no-store and responses with nothing to revalidate against', () => {
    expect(isStorable({ 'cache-control': 'no-store, max-age=300' })).toBe(false)
    expect(isStorable({ 'cache-control': 'max-age=0' })).toBe(false)
    expect(isStorable({})).toBe(false)
  })
})

describe('cacheIsFresh', () => {
  it('accepts an entry inside its max-age window', () => {
    const entry = { maxAge: 60, storedAt: 1_000 }
    expect(cacheIsFresh(entry, 30_000)).toBe(true)
  })

  it('rejects an expired entry and one with no max-age', () => {
    expect(cacheIsFresh({ maxAge: 60, storedAt: 1_000 }, 61_001)).toBe(false)
    expect(cacheIsFresh({ maxAge: 0, storedAt: 1_000 }, 1_001)).toBe(false)
  })
})

describe('ResponseCache', () => {
  let directory
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'cache-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('round-trips an entry by URL', async () => {
    const cache = new ResponseCache(directory)
    await cache.put('https://example.com/a', { result: { statusCode: 200 }, maxAge: 60, storedAt: 1 })
    expect(await cache.get('https://example.com/a')).toEqual({ result: { statusCode: 200 }, maxAge: 60, storedAt: 1 })
  })

  it('treats a missing entry as a miss', async () => {
    const cache = new ResponseCache(directory)
    expect(await cache.get('https://example.com/missing')).toBeNull()
  })

  it('treats a corrupt entry as a miss instead of failing', async () => {
    const cache = new ResponseCache(directory)
    await cache.put('https://example.com/a', { result: {}, maxAge: 1, storedAt: 1 })
    await writeFile(cache.path('https://example.com/a'), '{not json')
    expect(await cache.get('https://example.com/a')).toBeNull()
  })

  it('keeps distinct URLs apart and hashes long query strings safely', async () => {
    const cache = new ResponseCache(directory)
    const long = `https://example.com/a?q=${'x'.repeat(4000)}`
    await cache.put('https://example.com/a', { result: { id: 1 }, maxAge: 60, storedAt: 1 })
    await cache.put(long, { result: { id: 2 }, maxAge: 60, storedAt: 1 })
    expect((await cache.get('https://example.com/a')).result.id).toBe(1)
    expect((await cache.get(long)).result.id).toBe(2)
  })

  it('clears every entry', async () => {
    const cache = new ResponseCache(directory)
    await cache.put('https://example.com/a', { result: {}, maxAge: 60, storedAt: 1 })
    await cache.clear()
    expect(await cache.get('https://example.com/a')).toBeNull()
  })
})
