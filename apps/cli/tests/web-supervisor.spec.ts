/** Fresh-process Web replacement uses an owned IPC child and a real ephemeral TCP port. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/web-supervisor.mjs', import.meta.url))
const tsxLoader = import.meta.resolve('tsx/esm')

interface RecordedEvent {
  event: string
  pid: number
  generation?: number
  argv?: string[]
  port?: number
  code?: number
}

/** Read only fixture-owned JSON lines, after subprocess output has settled. */
function events(file: string): RecordedEvent[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as RecordedEvent)
}

/** Start one IPC fixture and await the owned process before deleting its private log. */
async function withSupervisor(
  mode: string,
  assertion: (child: ChildProcess, file: string, completion: Promise<number>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-supervisor-'))
  const file = join(dir, 'events.jsonl')
  writeFileSync(file, '', 'utf8')
  const child = spawn(process.execPath, ['--import', tsxLoader, fixture, file, mode, '--port', '0', '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, DSH_WEB_SUPERVISED_CHILD: '' },
  })
  let stderr = ''
  child.stdout?.resume()
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const completion = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`supervisor fixture did not exit: ${stderr}`))
    }, 20_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (signal !== null) reject(new Error(`fixture killed by ${signal}: ${stderr}`))
      else resolve(code ?? 1)
    })
  })
  try {
    await assertion(child, file, completion)
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.connected) {
      child.send({ type: 'fixture-interrupt' })
    }
    await completion
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Web process supervisor', () => {
  it('coalesces restart requests and replaces only after the old child exits, retaining its bound port', async () => {
    await withSupervisor('restart', async (_child, file, completion) => {
      expect(await completion).toBe(0)
      const log = events(file)
      const starts = log.filter(row => row.event === 'child-start')
      const ready = log.filter(row => row.event === 'child-ready')
      expect(starts).toHaveLength(2)
      expect(starts[0]?.pid).not.toBe(starts[1]?.pid)
      expect(ready).toHaveLength(2)
      expect(ready[0]?.port).toBeGreaterThan(0)
      expect(ready[1]?.port).toBe(ready[0]?.port)
      expect(starts[1]?.argv?.slice(-3)).toEqual(['--port', String(ready[0]?.port), '--no-open'])
      const firstExit = log.findIndex(row => row.event === 'child-exit' && row.generation === 1)
      const replacement = log.findIndex(row => row.event === 'child-start' && row.generation === 2)
      expect(firstExit).toBeGreaterThan(-1)
      expect(replacement).toBeGreaterThan(firstExit)
    })
  }, 30_000)

  it.each([['crash', 23], ['clean-exit', 0], ['restart-failure', 23]] as const)(
    'does not respawn after %s', async (mode, expectedCode) => {
      await withSupervisor(mode, async (_child, file, completion) => {
        expect(await completion).toBe(expectedCode)
        expect(events(file).filter(row => row.event === 'child-start')).toHaveLength(1)
      })
    }, 30_000,
  )

  it('drains its child and returns 130 after a user interrupt without replacing it', async () => {
    await withSupervisor('interrupt', async (child, file, completion) => {
      await expect.poll(() => events(file).some(row => row.event === 'child-ready'), { timeout: 10_000 }).toBe(true)
      child.send({ type: 'fixture-interrupt' })
      expect(await completion).toBe(130)
      const log = events(file)
      expect(log.filter(row => row.event === 'child-start')).toHaveLength(1)
      expect(log.some(row => row.event === 'child-disposed')).toBe(true)
      expect(log.findIndex(row => row.event === 'supervisor-exit'))
        .toBeGreaterThan(log.findIndex(row => row.event === 'child-exit'))
    })
  }, 30_000)
})
