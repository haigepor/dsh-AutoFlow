/** Sandbox preparation retains integrity and failure checks across download sources. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'

const bash = process.platform === 'win32' ? join(process.env['ProgramFiles'] ?? 'C:/Program Files', 'Git/bin/bash.exe') : 'bash'
const script = fileURLToPath(new URL('./prepare-ci-bubblewrap.sh', import.meta.url)).replaceAll('\\', '/')
const digest = 'db4d572a7927bfd34cc9b8e24b56983efa8e0483d03da6c810f6caae081dcc36'

function runFixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ci-bwrap-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const bin = join(root, 'bin'), trace = join(root, 'trace'), githubPath = join(root, 'github-path')
  mkdirSync(bin)
  writeFileSync(githubPath, '', 'utf8')
  const commands: Record<string, string> = {
    uname: 'if [[ "$1" == -s ]]; then echo Linux; else echo x86_64; fi',
    curl: `
url="\${@: -1}"
printf 'curl:%s\\n' "$url" >> "$BWRAP_TEST_TRACE"
if [[ "$BWRAP_TEST_MODE" == unavailable || "$BWRAP_TEST_MODE" == launchpad-unavailable && "$url" == *launchpad.net* || "$BWRAP_TEST_MODE" == archive-unavailable && "$url" == *archive.ubuntu.com* ]]; then exit 22; fi
while [[ "$1" != --output ]]; do shift; done
printf fixture > "$2"`,
    sha256sum: `
read -r expected archive
printf 'checksum:%s\\n' "$expected" >> "$BWRAP_TEST_TRACE"
[[ "$BWRAP_TEST_MODE" != checksum-rejected ]]`,
    'dpkg-deb': `
echo extract >> "$BWRAP_TEST_TRACE"
mkdir -p "$3/usr/bin"
cp "$BWRAP_TEST_BIN/bwrap" "$3/usr/bin/bwrap"
chmod +x "$3/usr/bin/bwrap"`,
    sudo: 'exit 0',
    bwrap: `
printf 'bwrap:%s\\n' "$*" >> "$BWRAP_TEST_TRACE"
if [[ "$1" != --version && "$BWRAP_TEST_MODE" == probe-rejected ]]; then exit 42; fi`,
  }
  for (const [name, body] of Object.entries(commands)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { encoding: 'utf8', mode: 0o755 })
  }
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c',
    'export PATH="$(cd "$BWRAP_TEST_BIN" && pwd):$PATH"; exec bash "$BWRAP_TEST_SCRIPT"'], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
    env: { ...process.env, PATH: bin + delimiter + (process.env.PATH ?? ''),
      RUNNER_TEMP: root.replaceAll('\\', '/'), GITHUB_PATH: githubPath.replaceAll('\\', '/'),
      BWRAP_TEST_BIN: bin.replaceAll('\\', '/'), BWRAP_TEST_TRACE: trace.replaceAll('\\', '/'),
      BWRAP_TEST_SCRIPT: script, BWRAP_TEST_MODE: mode },
  })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.signal).toBeNull()
  return { result, trace: readFileSync(trace, 'utf8').trim().split('\n'), path: readFileSync(githubPath, 'utf8') }
}

describe.skipIf(process.platform === 'win32' && !existsSync(bash))('pinned bubblewrap preparation', () => {
  it('uses the Ubuntu archive when Launchpad is unavailable', () => {
    const f = runFixture('launchpad-unavailable')
    expect(f.result.status, f.result.stderr).toBe(0)
    expect(f.trace[0]).toContain('https://archive.ubuntu.com/ubuntu/pool/main/b/bubblewrap/')
    expect(f.trace.filter(line => line.startsWith('curl:'))).toHaveLength(1)
    expect(f.trace).toContain(`checksum:${digest}`)
    expect(f.trace).toContain('bwrap:--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true')
    expect(f.path).toContain('/dsh-bubblewrap/usr/bin')
  })

  it('retains the recorded build when Ubuntu prunes the pool package', () => {
    const f = runFixture('archive-unavailable')
    expect(f.result.status, f.result.stderr).toBe(0)
    const sources = f.trace.filter(line => line.startsWith('curl:'))
    expect(sources).toHaveLength(2)
    expect(sources[1]).toContain('https://launchpad.net/ubuntu/+source/bubblewrap/')
    expect(f.trace).toContain(`checksum:${digest}`)
  })

  it.each([['unavailable', 1], ['checksum-rejected', 1], ['probe-rejected', 42]] as const)(
    'fails closed when %s', (mode, status) => {
      const f = runFixture(mode)
      expect(f.result.status, f.result.stderr).toBe(status)
      expect(f.result.stdout).not.toContain('functional probe passed')
      if (mode !== 'probe-rejected') {
        expect(f.trace).not.toContain('extract')
        expect(f.path).toBe('')
      }
      if (mode === 'checksum-rejected') expect(f.trace.filter(line => line.startsWith('curl:'))).toHaveLength(1)
    },
  )
})
