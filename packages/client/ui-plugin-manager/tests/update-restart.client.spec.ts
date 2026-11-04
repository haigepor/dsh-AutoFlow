/** Recovery requires a new ready Host, including when teardown drops the commit reply. */
import { afterEach, expect, it, vi } from 'vitest'
import { waitForUpdatedWebHost, waitForAutomaticPluginRestart } from '../src/client/update-restart.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('waits for active work without spending the replacement Host recovery deadline', async () => {
  vi.useFakeTimers()
  // Node's native timeout uses an internal clock that Vitest cannot advance.
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController()
    setTimeout(() => { controller.abort(new Error('Recovery expired')) }, milliseconds)
    return controller.signal
  })
  try {
    const idle = Promise.withResolvers<boolean>()
    const request = vi.fn().mockResolvedValue(Response.json({ generation: 'new', ready: true }))
    vi.stubGlobal('fetch', request)
    const task = waitForUpdatedWebHost({ generation: 'old', ready: true, supported: true, timeoutMs: 20000 },
      () => idle.promise, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(60000)
    expect(request).not.toHaveBeenCalled()
    idle.resolve(true)
    await task
    expect(request).toHaveBeenCalledOnce()
  } finally { timeout.mockRestore() }
})

it('defers automatic plugin restart while work is active and resumes without confirmation', async () => {
  vi.useFakeTimers()
  const attempt = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const waiting = vi.fn()
  const result = waitForAutomaticPluginRestart(attempt, new AbortController().signal, waiting)
  await vi.advanceTimersByTimeAsync(0)
  expect(waiting).toHaveBeenLastCalledWith(true)
  await vi.advanceTimersByTimeAsync(2000)
  expect(await result).toBe(true)
  expect(attempt).toHaveBeenCalledTimes(3)
  expect(waiting).toHaveBeenLastCalledWith(false)
})

it('stops deferred attempts when its plugin lifetime ends', async () => {
  vi.useFakeTimers()
  const attempt = vi.fn(async () => false)
  const lifetime = new AbortController()
  const result = waitForAutomaticPluginRestart(attempt, lifetime.signal, () => {})
  const rejected = expect(result).rejects.toThrow('Stopped')
  await vi.advanceTimersByTimeAsync(0)
  lifetime.abort(new Error('Stopped'))
  await rejected
  await vi.advanceTimersByTimeAsync(5000)
  expect(attempt).toHaveBeenCalledOnce()
})

it('waits through the old generation and reloads only after a new ready Host', async () => {
  vi.useFakeTimers()
  const request = vi.fn()
    .mockResolvedValueOnce(Response.json({ generation: 'old', ready: true }))
    .mockResolvedValueOnce(Response.json({ generation: 'new', ready: false }))
    .mockResolvedValueOnce(Response.json({ generation: 'new', ready: true }))
  vi.stubGlobal('fetch', request)
  const commit = vi.fn().mockRejectedValue(new Error('Old Host disconnected'))
  const done = vi.fn()
  const task = waitForUpdatedWebHost({ generation: 'old', ready: true, supported: true, timeoutMs: 20000 },
    commit, new AbortController().signal).then(done)
  await vi.advanceTimersByTimeAsync(1000)
  expect(done).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  await task
  expect(commit).toHaveBeenCalledOnce()
  expect(request).toHaveBeenCalledTimes(3)
  expect(done).toHaveBeenCalledOnce()
})

it('cancels a pending recovery without accepting late readiness', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ generation: 'old', ready: true })))
  const owner = new AbortController()
  const task = waitForUpdatedWebHost({ generation: 'old', ready: true, supported: true, timeoutMs: 20000 },
    async () => undefined, owner.signal)
  const rejected = expect(task).rejects.toThrow('Stopped')
  await vi.advanceTimersByTimeAsync(0)
  owner.abort(new Error('Stopped'))
  await rejected
})

it('refuses an unmanaged launcher without sending a restart', async () => {
  const commit = vi.fn()
  await expect(waitForUpdatedWebHost({ generation: 'old', ready: true, supported: false, timeoutMs: 20000 },
    commit, new AbortController().signal)).rejects.toThrow('does not support restart')
  expect(commit).not.toHaveBeenCalled()
})

it('reports an explicit busy refusal without waiting for a replacement Host', async () => {
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  await expect(waitForUpdatedWebHost({ generation: 'old', ready: true, supported: true, timeoutMs: 20000 },
    async () => false, new AbortController().signal)).rejects.toThrow('refused restart')
  expect(request).not.toHaveBeenCalled()
})
