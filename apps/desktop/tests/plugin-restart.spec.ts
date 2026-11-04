/** Automatic plugin restart waits for idle admission and schedules one replacement application. */
import { expect, it, vi } from 'vitest'
import { createPluginRestart } from '../src/plugin-restart.ts'

it('does not arm relaunch while work is active', async () => {
  const options = { allowed: () => true, prepare: vi.fn(async () => false), release: vi.fn(async () => {}),
    relaunch: vi.fn(), quit: vi.fn() }
  expect(await createPluginRestart(options)()).toBe(false)
  expect(options.relaunch).not.toHaveBeenCalled()
  expect(options.quit).not.toHaveBeenCalled()
})

it('joins concurrent requests and schedules one relaunch before orderly quit', async () => {
  const steps: string[] = []
  const options = { allowed: () => true, prepare: vi.fn(async () => true), release: vi.fn(async () => {}),
    relaunch: vi.fn(() => { steps.push('relaunch') }), quit: vi.fn(() => { steps.push('quit') }) }
  const restart = createPluginRestart(options)
  const first = restart()
  expect(restart()).toBe(first)
  expect(await first).toBe(true)
  expect(await restart()).toBe(true)
  expect(options.prepare).toHaveBeenCalledOnce()
  expect(steps).toEqual(['relaunch', 'quit'])
})

it('unlocks admission after availability changes or native relaunch fails', async () => {
  let allowed = true
  const options = { allowed: () => allowed,
    prepare: vi.fn(async () => { allowed = false; return true }), release: vi.fn(async () => {}), relaunch: vi.fn(), quit: vi.fn() }
  const restart = createPluginRestart(options)
  expect(await restart()).toBe(false)
  expect(options.relaunch).not.toHaveBeenCalled()
  expect(options.release).toHaveBeenCalledOnce()
  allowed = true
  options.prepare.mockImplementation(async () => true)
  options.relaunch.mockImplementationOnce(() => { throw new Error('Native relaunch failed') })
  await expect(restart()).rejects.toThrow('Native relaunch failed')
  expect(options.quit).not.toHaveBeenCalled()
  expect(options.release).toHaveBeenCalledTimes(2)
  expect(await restart()).toBe(true)
})
