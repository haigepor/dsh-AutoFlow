/** Reject invalid native redistributables before mutating the prepared Office helper directory. */
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareWindowsCppRuntime } from '../scripts/windows-cpp-runtime.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe.skipIf(process.platform !== 'win32')('Windows app-local CRT validation', () => {
  it.each([
    { machine: 0x14c, message: /expected an x64 PE DLL/u },
    { machine: 0x8664, message: /invalid Microsoft signature/u },
  ])('rejects architecture/signature failures before copying ($machine)', async ({ machine, message }) => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-crt-rejection-'))
    roots.push(root)
    const source = join(root, 'source')
    const output = join(root, 'output')
    await mkdir(source)
    const bytes = Buffer.alloc(512)
    bytes.write('MZ')
    bytes.writeUInt32LE(0x80, 0x3c)
    bytes.writeUInt32LE(0x4550, 0x80)
    bytes.writeUInt16LE(machine, 0x84)
    for (const name of ['a.dll', 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) await writeFile(join(source, name), bytes)
    await expect(prepareWindowsCppRuntime(output, { ...process.env, DSH_DESKTOP_WINDOWS_CRT_DIR: source })).rejects.toThrow(message)
    await expect(access(output)).rejects.toThrow()
  }, 30_000)
})
