/** Configuration recovery accepts only a replacement Host and stops with its owner. */
import { afterEach, expect, it, vi } from 'vitest'
import { waitForConfigurationRestart } from '../src/client/restart.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const status = {
  generation: 'old' as Parameters<typeof waitForConfigurationRestart>[0]['generation'],
  ready: true, supported: true, timeoutMs: 20000,
}

it('survives a disconnected reply and waits for a different ready Host', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ generation: 'old', ready: true }))
    .mockResolvedValueOnce(Response.json({ generation: 'new', ready: false }))
    .mockResolvedValueOnce(Response.json({ generation: 'new', ready: true }))
  vi.stubGlobal('fetch', fetch)
  const commit = vi.fn().mockRejectedValue(new Error('Disconnected'))
  const done = vi.fn()
  const pending = waitForConfigurationRestart(status, commit, new AbortController().signal).then(done)
  await vi.advanceTimersByTimeAsync(1000)
  expect(done).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  await pending
  expect(commit).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(done).toHaveBeenCalledOnce()
})

it('reports refusal immediately and does not poll', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(waitForConfigurationRestart(status, async () => false, new AbortController().signal))
    .rejects.toThrow('Restart refused')
  expect(fetch).not.toHaveBeenCalled()
})

it('cancels pending recovery when its registration unloads', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ generation: 'old', ready: true })))
  const owner = new AbortController()
  const pending = waitForConfigurationRestart(status, async () => true, owner.signal)
  const rejected = expect(pending).rejects.toThrow('Unloaded')
  await vi.advanceTimersByTimeAsync(0)
  owner.abort(new Error('Unloaded'))
  await rejected
})
