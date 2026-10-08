/** Plugin restart preserves native cancellation and schedules only one replacement application. */
import { expect, it, vi } from 'vitest'
import { createPluginRestart } from '../src/plugin-restart.ts'

it('does not arm relaunch when confirmation is declined', async () => {
  const options = { allowed: () => true, confirm: vi.fn(async () => false), relaunch: vi.fn(), quit: vi.fn() }
  expect(await createPluginRestart(options)()).toBe(false)
  expect(options.relaunch).not.toHaveBeenCalled()
  expect(options.quit).not.toHaveBeenCalled()
})

it('joins concurrent requests and schedules one relaunch before orderly quit', async () => {
  const steps: string[] = []
  const options = { allowed: () => true, confirm: vi.fn(async () => true),
    relaunch: vi.fn(() => { steps.push('relaunch') }), quit: vi.fn(() => { steps.push('quit') }) }
  const restart = createPluginRestart(options)
  const first = restart()
  expect(restart()).toBe(first)
  expect(await first).toBe(true)
  expect(await restart()).toBe(true)
  expect(options.confirm).toHaveBeenCalledOnce()
  expect(steps).toEqual(['relaunch', 'quit'])
})

it('rechecks availability after confirmation and permits retry after native failure', async () => {
  let allowed = true
  const options = { allowed: () => allowed,
    confirm: vi.fn(async () => { allowed = false; return true }), relaunch: vi.fn(), quit: vi.fn() }
  const restart = createPluginRestart(options)
  expect(await restart()).toBe(false)
  expect(options.relaunch).not.toHaveBeenCalled()
  allowed = true
  options.confirm.mockImplementation(async () => true)
  options.relaunch.mockImplementationOnce(() => { throw new Error('Native relaunch failed') })
  await expect(restart()).rejects.toThrow('Native relaunch failed')
  expect(options.quit).not.toHaveBeenCalled()
  expect(await restart()).toBe(true)
})
