/** Recovery delays release both browser resources on completion and owner cancellation. */
import { afterEach, expect, it, vi } from 'vitest'
import { waitForAbortableDelay } from '../src/abortable-delay.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('waits for the interval and removes its abort listener when it completes', async () => {
  vi.useFakeTimers()
  const owner = new AbortController()
  const remove = vi.spyOn(owner.signal, 'removeEventListener')
  const settled = vi.fn()
  const pending = waitForAbortableDelay(1000, owner.signal).then(settled)
  await vi.advanceTimersByTimeAsync(999)
  expect(settled).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await pending
  expect(settled).toHaveBeenCalledOnce()
  expect(remove).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([true, false])('cancels and clears resources when pre-aborted is %s', async (preAborted) => {
  vi.useFakeTimers()
  const owner = new AbortController()
  const reason = new Error('Owner unloaded')
  if (preAborted) owner.abort(reason)
  const remove = vi.spyOn(owner.signal, 'removeEventListener')
  const pending = waitForAbortableDelay(1000, owner.signal)
  const rejected = expect(pending).rejects.toBe(reason)
  if (!preAborted) owner.abort(reason)
  await rejected
  expect(remove).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('uses an AbortError when cancellation supplies no Error object', async () => {
  vi.useFakeTimers()
  await expect(waitForAbortableDelay(1000, AbortSignal.abort('stopped'))).rejects.toMatchObject({ name: 'AbortError' })
  expect(vi.getTimerCount()).toBe(0)
})
