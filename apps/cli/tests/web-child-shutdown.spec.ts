/** Parent shutdown requests must survive asynchronous supervised Web startup. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/bin.ts'
import { runProfile } from '../src/profile-boot.ts'

vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  getDshRuntimeVersion: () => '0.2.0-rc.2',
  loadLayeredEnv: vi.fn(),
  StartupError: class StartupError extends Error {},
}))
vi.mock('../src/profile-boot.ts', () => ({ runProfile: vi.fn() }))
vi.mock('../src/startup-diagnostics.ts', () => ({ reportStartupFailure: vi.fn() }))

const originalArgv = process.argv
const connectedDescriptor = Object.getOwnPropertyDescriptor(process, 'connected')

afterEach(() => {
  process.argv = originalArgv
  if (connectedDescriptor === undefined) Reflect.deleteProperty(process, 'connected')
  else Object.defineProperty(process, 'connected', connectedDescriptor)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

describe('supervised Web startup', () => {
  it.each(['shutdown', 'disconnect'] as const)('remembers an early parent %s until boot returns', async (request) => {
    process.argv = [process.execPath, '/owned/dsh/bin.js', 'web', '--no-open']
    Object.defineProperty(process, 'connected', { configurable: true, value: true })
    vi.stubEnv('DSH_WEB_SUPERVISED_CHILD', '1')
    const on = vi.spyOn(process, 'on').mockReturnValue(process)
    const once = vi.spyOn(process, 'once').mockReturnValue(process)
    const interrupt = vi.fn()
    const ctx = new Context()
    let resolveBoot!: (application: Awaited<ReturnType<typeof runProfile>>) => void
    vi.mocked(runProfile).mockImplementation(() => new Promise((resolve) => { resolveBoot = resolve }))
    const pending = runCli()
    try {
      await vi.waitFor(() => { expect(runProfile).toHaveBeenCalledOnce() })
      if (request === 'shutdown') {
        const registration = on.mock.calls.find(([event]) => event === 'message')
        registration?.[1]({ type: 'dsh-web-shutdown' })
      } else {
        const registration = once.mock.calls.find(([event]) => event === 'disconnect')
          ?? on.mock.calls.find(([event]) => event === 'disconnect')
        registration?.[1]()
      }
      resolveBoot({ ctx, shutdown: { interrupt, shutdown: async () => undefined } })
      await pending
      expect(interrupt).toHaveBeenCalledExactlyOnceWith(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
