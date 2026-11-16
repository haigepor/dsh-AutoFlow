/** Resolver installation uses exposed Node internals without loading the native fallback. */

import type { createRequire } from 'node:module'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { installRuntimeInterception, type RuntimeInterception } from '../src/profile-resolution/resolver.ts'
import type { RuntimeResolution } from '../src/profile.ts'

const access = vi.hoisted(() => ({
  direct: vi.fn<(id: string) => unknown>(),
  native: vi.fn<(id: string) => unknown>(),
  addon: vi.fn(),
}))

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (filename: Parameters<typeof createRequire>[0]) => {
      const require = actual.createRequire(filename)
      return new Proxy(require, {
        apply(target, thisArg, args: [string]) {
          const [id] = args
          if (id === 'node-addon-require-builtin') {
            access.addon()
            return { requireBuiltin: access.native }
          }
          if (id.startsWith('internal/')) return access.direct(id)
          return Reflect.apply(target, thisArg, args)
        },
      })
    },
  }
})

const ids = [
  'internal/modules/esm/loader',
  'internal/modules/cjs/loader',
  'internal/modules/helpers',
  'internal/modules/esm/utils',
  'internal/modules/esm/resolve',
]
const internals = new Map<string, unknown>()
const execArgv = [...process.execArgv]
let registration: RuntimeInterception | undefined
const resolution: RuntimeResolution = {
  profilesDir: '/profiles', profileDir: '/profiles/test',
  localPackageNames: [], linkedRoots: [], entries: [],
}

beforeAll(async () => {
  const { createRequire: requireFrom } = await vi.importActual<typeof import('node:module')>('node:module')
  const addon = requireFrom(import.meta.url)('node-addon-require-builtin') as { requireBuiltin(id: string): unknown }
  for (const id of ids) internals.set(id, addon.requireBuiltin(id))
})

beforeEach(() => {
  access.addon.mockReset()
  access.direct.mockReset().mockImplementation(id => internals.get(id))
  access.native.mockReset().mockImplementation(id => internals.get(id))
  process.execArgv.splice(0, process.execArgv.length, ...execArgv.filter(arg => arg !== '--expose-internals'))
})

afterEach(() => {
  registration?.dispose()
  registration = undefined
  process.execArgv.splice(0, process.execArgv.length, ...execArgv)
})

it('installs and disposes resolution through exposed internals without loading the addon', () => {
  process.execArgv.push('--expose-internals')
  registration = installRuntimeInterception(resolution)
  expect(access.direct.mock.calls.map(([id]) => id)).toEqual(ids)
  expect(access.addon).not.toHaveBeenCalled()
  expect(access.native).not.toHaveBeenCalled()
  registration.dispose()
  registration = undefined
})

it('retains native access when internals are not exposed', () => {
  registration = installRuntimeInterception(resolution)
  expect(access.direct).not.toHaveBeenCalled()
  expect(access.native.mock.calls.map(([id]) => id)).toEqual(ids)
})

it('uses native access only for an internal module that is unavailable through require', () => {
  process.execArgv.push('--expose-internals')
  access.direct.mockImplementation((id) => {
    if (id === ids[2]) throw Object.assign(new Error('internal module is private'), { code: 'MODULE_NOT_FOUND' })
    return internals.get(id)
  })
  registration = installRuntimeInterception(resolution)
  expect(access.direct.mock.calls.map(([id]) => id)).toEqual(ids)
  expect(access.native.mock.calls).toEqual([[ids[2]]])
})

it('preserves errors thrown by an exposed internal module', () => {
  process.execArgv.push('--expose-internals')
  const failure = new Error('internal module initialization failed')
  access.direct.mockImplementation(() => { throw failure })
  expect(() => { registration = installRuntimeInterception(resolution) }).toThrow(failure)
  expect(access.addon).not.toHaveBeenCalled()
})
