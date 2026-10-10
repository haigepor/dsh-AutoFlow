/** Exercise ad-hoc Apple command arguments and native runtime traversal with deterministic tool adapters. */
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { signMacOSAdHocCode, verifyMacOSAdHocSignature } from '../scripts/verify-macos-signature.mjs'
import { signMacOSRuntime } from '../scripts/macos-runtime.ts'

const apple = vi.hoisted(() => ({ code: 0, details: 'Signature=adhoc\nTeamIdentifier=not set\n' }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return { ...original,
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', apple.code, null) })
      return child
    }),
    spawnSync: vi.fn(() => ({ status: apple.code, signal: null, error: undefined, stdout: '', stderr: apple.details })),
  }
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  apple.code = 0; apple.details = 'Signature=adhoc\nTeamIdentifier=not set\n'
  vi.clearAllMocks()
})

it('signs without certificate discovery, a keychain or a timestamp service', async () => {
  await signMacOSAdHocCode('/fixture/code', 'com.example.test.runtime', '/fixture/jit.plist')
  expect(spawn).toHaveBeenCalledWith('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier',
    'com.example.test.runtime', '--timestamp=none', '--entitlements', '/fixture/jit.plist', '/fixture/code'], { stdio: ['ignore', 'pipe', 'pipe'] })
  verifyMacOSAdHocSignature('/fixture/App.app', true)
  expect(spawnSync).toHaveBeenCalledWith('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', '/fixture/App.app'], { encoding: 'utf8' })
})

it('rejects damaged code and rejects a certificate identity even when codesign exits successfully', () => {
  apple.code = 1
  expect(() =>{  verifyMacOSAdHocSignature('/fixture/code') }).toThrow('exited with 1')
  apple.code = 0; apple.details = 'Authority=Developer ID Application: Other\nTeamIdentifier=PRODTEAM12\n'
  expect(() =>{  verifyMacOSAdHocSignature('/fixture/code') }).toThrow('ad-hoc test signature')
})

it('applies test signatures to every materialized Mach-O, retains JIT entitlements and avoids the release cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'macos-ad-hoc-'))
  roots.push(root)
  const code = ['dependencies/node/bin/node', 'node_modules/package/native.node']
  for (const path of code) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
  }
  await writeFile(join(root, 'data.txt'), 'data')
  expect(await signMacOSRuntime(root, 'com.example.test', 'ad-hoc', 'arm64')).toBe(2)
  expect(vi.mocked(spawn).mock.calls.map(([, args]) => args?.at(-1)).sort()).toEqual(code.map(path => join(root, path)).sort())
  const node = vi.mocked(spawn).mock.calls.find(([, args]) => args?.at(-1) === join(root, code[0]!))
  expect(node?.[1]).toContain('--entitlements')
  expect(node?.[1]?.some(value => value.endsWith('jit-entitlements.plist'))).toBe(true)
  await expect(signMacOSRuntime(root, 'com.example.test', 'ad-hoc', 'arm64', join(root, 'cache'))).rejects.toThrow('release signature cache')
  apple.code = 1
  await expect(signMacOSRuntime(root, 'com.example.test', 'ad-hoc', 'arm64')).rejects.toThrow('native signing failed')
})
