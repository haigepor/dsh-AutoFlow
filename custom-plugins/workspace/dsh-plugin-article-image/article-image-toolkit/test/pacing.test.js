/** Per-host pacing: a token bucket that only spends time it must, and honors Retry-After. */
import { describe, expect, it } from 'vitest'
import { retryAfterMs, pacer } from '../src/pacing.js'

const config = { hostRatePerSecond: 2, hostBurst: 2, maxRetryAfterMs: 60_000 }

/** Pacer over a manual clock so no test depends on wall time. @param {object} [overrides] Config fields. @returns {object} Pacer, clock and recorded sleeps. */
function makePacer(overrides = {}) {
  let time = 1_000_000
  const sleeps = []
  const paced = new pacer({ ...config, ...overrides }, { now: () => time, sleep: async ms => { sleeps.push(ms); time += ms } })
  return { paced, sleeps, advance: ms => { time += ms }, at: () => time }
}

describe('retryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(retryAfterMs('5')).toBe(5000)
    expect(retryAfterMs('0')).toBe(0)
    expect(retryAfterMs(undefined)).toBe(0)
    expect(retryAfterMs('')).toBe(0)
  })

  it('reads an HTTP-date', () => {
    const now = Date.parse('2026-10-17T12:00:00Z')
    expect(retryAfterMs('Sat, 17 Oct 2026 12:00:30 GMT', now)).toBe(30_000)
    expect(retryAfterMs('Sat, 17 Oct 2026 11:59:00 GMT', now)).toBe(0)
  })

  it('caps an absurd delay and ignores garbage', () => {
    expect(retryAfterMs('99999')).toBe(600_000)
    expect(retryAfterMs('soon')).toBe(0)
  })
})

describe('pacer', () => {
  it('spends the burst immediately, then waits exactly one token', async () => {
    const { paced, sleeps } = makePacer()
    await paced.acquire('example.com')
    await paced.acquire('example.com')
    expect(sleeps).toEqual([])
    await paced.acquire('example.com')
    // 2 次/秒 → 一个令牌 500ms。
    expect(sleeps).toEqual([500])
  })

  it('refills over elapsed time instead of sleeping', async () => {
    const { paced, sleeps, advance } = makePacer()
    await paced.acquire('example.com')
    await paced.acquire('example.com')
    advance(1000)
    await paced.acquire('example.com')
    expect(sleeps).toEqual([])
  })

  it('keeps host budgets independent', async () => {
    const { paced, sleeps } = makePacer()
    await paced.acquire('a.example')
    await paced.acquire('a.example')
    await paced.acquire('b.example')
    expect(sleeps).toEqual([])
  })

  it('blocks one host for the declared Retry-After and reports the wait', async () => {
    const { paced, sleeps, at } = makePacer()
    const applied = paced.defer('example.com', '3')
    expect(applied).toBe(3000)
    expect(at()).toBe(1_000_000)
    await paced.acquire('example.com')
    expect(sleeps).toEqual([3000])
    // 阻塞结束后仍受令牌桶约束，但不再重复等待。
    await paced.acquire('example.com')
    expect(sleeps).toEqual([3000])
  })

  it('caps a server-directed delay at maxRetryAfterMs', () => {
    const { paced } = makePacer({ maxRetryAfterMs: 2000 })
    expect(paced.defer('example.com', '120')).toBe(2000)
  })

  it('returns zero for a Retry-After it cannot use', () => {
    const { paced, sleeps } = makePacer()
    expect(paced.defer('example.com', undefined)).toBe(0)
    expect(paced.defer('example.com', 'later')).toBe(0)
    expect(sleeps).toEqual([])
  })

  it('does not sleep once the caller has aborted', async () => {
    const { paced, sleeps } = makePacer()
    const controller = new AbortController()
    controller.abort()
    await paced.acquire('example.com', controller.signal)
    expect(sleeps).toEqual([])
  })

  it('releases a sleeping caller when the signal aborts', async () => {
    let time = 1_000_000
    const controller = new AbortController()
    const paced = new pacer({ ...config, hostRatePerSecond: 0.001, hostBurst: 1 }, { now: () => time })
    await paced.acquire('example.com')
    // 下一次需要一个令牌 = 1000s；中止让等待立刻返回而不是真的睡过去。
    const waiting = paced.acquire('example.com', controller.signal)
    controller.abort()
    await expect(waiting).resolves.toBeUndefined()
  })
})
