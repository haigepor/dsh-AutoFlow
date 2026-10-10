import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { releaseMetadata, verifyPackedEntries } from '../scripts/prepare-release.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const config = JSON.parse(readFileSync(new URL('../release.config.json', import.meta.url), 'utf8'))
const asset = { tag: `${config.tagPrefix}${manifest.version}`, sourceCommit: 'a'.repeat(40), sha256: 'b'.repeat(64), size: 1024, sourceDirty: false }

test('AFP draft lookup handles delayed visibility, missing drafts and API errors', t => {
  const bash = process.platform === 'win32'
    ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe') : 'bash'
  if (process.platform === 'win32' && !existsSync(bash)) return t.skip('Git Bash is unavailable')
  const workflow = readFileSync(new URL('../../../../.github/workflows/release-afp.yml', import.meta.url), 'utf8')
  const lookup = workflow.match(/^          wait_for_created_release_id\(\) \{[\s\S]*?^          \}/m)?.[0]
  assert.ok(lookup)
  const root = mkdtempSync(join(tmpdir(), 'afp-release-lookup-'))
  try {
    for (const [mode, status, calls, waits] of [['delayed', 0, 3, 2], ['missing', 1, 10, 10], ['api-error', 1, 1, 0]]) {
      const counter = join(root, 'calls'), waiting = join(root, 'waits')
      writeFileSync(counter, '0\n', 'utf8')
      writeFileSync(waiting, '', 'utf8')
      const script = `set -e
find_release_id() {
  IFS= read -r calls < "$COUNTER_FILE"; calls=$((calls + 1))
  printf '%s\\n' "$calls" > "$COUNTER_FILE"
  if test "$LOOKUP_MODE" = api-error; then return 7; fi
  if test "$LOOKUP_MODE" = delayed && test "$calls" -ge 3; then echo 407632532; else echo 0; fi
}
sleep() { printf '%s\\n' "$1" >> "$WAIT_FILE"; }
${lookup.split('\n').map(line => line.slice(10)).join('\n')}
wait_for_created_release_id
`
      // 内建 read 避免轮询反复创建 cat；外层预算覆盖 Windows Bash 启动，不替代业务重试次数断言。
      const result = spawnSync(bash, ['--noprofile', '--norc', '-c', script], {
        encoding: 'utf8', windowsHide: true, timeout: 30_000,
        env: { ...process.env, LOOKUP_MODE: mode, COUNTER_FILE: counter.replaceAll('\\', '/'), WAIT_FILE: waiting.replaceAll('\\', '/') },
      })
      assert.equal(result.signal, null, 'Draft lookup child was terminated before completing')
      assert.equal(result.error, undefined)
      assert.equal(result.status, status, result.stderr)
      assert.equal(Number(readFileSync(counter, 'utf8')), calls)
      assert.equal(readFileSync(waiting, 'utf8').trim().split('\n').filter(Boolean).length, waits)
      if (mode === 'delayed') assert.equal(result.stdout.trim(), '407632532')
      if (mode === 'missing') assert.match(result.stderr, /did not become visible/)
    }
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'afp-release-lookup-'))
    rmSync(root, { recursive: true, force: true })
  }
})

test('AFP release metadata points to the exact tag asset and records rehearsal sources', () => {
  const metadata = releaseMetadata(manifest, config, asset)
  assert.equal(metadata.asset.url, `https://github.com/${config.repository}/releases/download/${asset.tag}/dsh-plugin-afp-${manifest.version}.tgz`)
  assert.equal(metadata.sourceDirty, false)
  assert.equal(releaseMetadata(manifest, config, { ...asset, sourceDirty: true }).sourceDirty, true)
})

test('AFP publication rejects another package, mismatched tags and unstable versions', () => {
  assert.throws(() => releaseMetadata({ ...manifest, name: 'another-plugin' }, config, asset), /Unexpected package/)
  assert.throws(() => releaseMetadata(manifest, config, { ...asset, tag: 'autoflow-v0.1.0' }), /Tag and package version/)
  assert.throws(() => releaseMetadata({ ...manifest, version: '0.1.0-beta.1' }, config, asset), /stable package version/)
})

test('AFP publication rejects invalid repository, digest, size and source commit', () => {
  assert.throws(() => releaseMetadata(manifest, { ...config, repository: 'owner/repo/escape' }, asset), /Invalid GitHub/)
  assert.throws(() => releaseMetadata(manifest, config, { ...asset, sha256: 'invalid' }), /digest/)
  assert.throws(() => releaseMetadata(manifest, config, { ...asset, size: 0 }), /size/)
  assert.throws(() => releaseMetadata(manifest, config, { ...asset, sourceCommit: 'HEAD' }), /commit/)
  assert.throws(() => releaseMetadata(manifest, { ...config, makeLatest: true }, asset), /application latest/)
})

test('AFP archive validation rejects escaping paths and local environment files', () => {
  assert.throws(() => verifyPackedEntries(manifest, ['package/../escape']), /Unsafe archive/)
  assert.throws(() => verifyPackedEntries(manifest, ['package/.env']), /Unwanted archive/)
  assert.throws(() => verifyPackedEntries(manifest, ['package/node_modules/dependency/index.js']), /Unwanted archive/)
})

test('AFP archive validation rejects a missing Client entry', () => {
  assert.throws(() => verifyPackedEntries(manifest, ['package/package.json']), /Missing packed file: client.js/)
})
