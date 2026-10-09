import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, rename, open, stat, mkdir, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Store, replaceRecordFile } from '../src/host/afp-state-store.js'
import { resolveConfig } from '../config-schema.js'
import { readFailure, savedReadFailure } from '../src/vendor/auto-afp-img/read-failure.mjs'
import { diagnosticFailure } from '../src/host/afp-diagnostics.js'
import { validatePreviewUrl } from '../src/vendor/auto-afp-img/afp-preview-client.mjs'
import { triageCandidates } from '../src/vendor/auto-afp-img/afp-visual-triage.mjs'

test('blocked preview retains its exact host without retaining signed media URLs', () => {
  let blocked
  try { validatePreviewUrl('https://cdn.example.test/photo?signature=secret') } catch (error) { blocked = error }
  assert.equal(readFailure(blocked, 'preview').code, 'preview-host-blocked')
  assert.deepEqual(savedReadFailure(readFailure(blocked, 'preview')), {
    code: 'preview-host-blocked', stage: 'preview', retryable: false, host: 'cdn.example.test',
  })
  assert.equal(diagnosticFailure(blocked, 'preview').host, 'cdn.example.test')
  assert.doesNotMatch(JSON.stringify(diagnosticFailure(blocked, 'preview')), /signature|secret|https:/)
})

test('filesystem checkpoint errors remain distinct from provider preview errors', () => {
  const error = Object.assign(new Error('rename private-path'), { code: 'EPERM' })
  assert.deepEqual(readFailure(error, 'checkpoint-save'), { code: 'checkpoint-save-failed', stage: 'checkpoint-save', retryable: false })
  assert.equal(savedReadFailure(readFailure(error, 'checkpoint-save')).stage, 'checkpoint-save')
})

test('a blocked CDN checkpoints unfinished outcomes and stops admitting more previews', async () => {
  let calls = 0
  const decisions = [], progress = []
  await assert.rejects(triageCandidates({
    candidateManifest: { categories: [{ category: 'food', candidates: [{ id: 'first' }, { id: 'second' }] }] },
    concurrency: 1, previewClient: { async getPreviewBytes() {
      calls++; validatePreviewUrl('https://cdn.example.test/photo?signature=secret')
    } }, visionClient: { complete() { throw new Error('vision must not be called') } },
    onResult: decision => decisions.push(decision), onProgress: row => progress.push(row),
  }), error => error.code === 'preview-host-blocked')
  assert.equal(calls, 1)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].failure.code, 'preview-host-blocked')
  assert.equal(progress.at(-1).requestFailures, 1)
  assert.equal(progress.at(-1).pixelReviewed, 0)
})

test('Windows checkpoint replacement waits for a short-lived reader without deleting the old record',
  { skip: process.platform !== 'win32' }, async t => {
    const home = await mkdtemp(join(tmpdir(), 'afp-windows-store-'))
    assert.equal(dirname(resolve(home)), resolve(tmpdir()))
    assert.ok(basename(home).startsWith('afp-windows-store-'))
    const config = resolveConfig()
    const store = new Store(home, join(home, 'profile'), config.maxStateBytes,
      { ...config, stateWriteRetryCount: 8, stateWriteRetryDelayMs: 50 })
    const run = await store.createRun(['food'], config)
    const file = join(store.profile, 'runs', `${run.id}.json`)
    const script = `$stream=[IO.File]::Open('${file.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $stream.Dispose() }`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const closed = once(child, 'close')
    let release
    t.after(async () => { clearTimeout(release); child.stdin.end('\n'); await closed; await rm(home, { recursive: true, force: true }) })
    await new Promise((done, fail) => {
      let output = ''
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('LOCKED')) done() })
      child.once('error', fail)
      child.once('close', code => { if (!output.includes('LOCKED')) fail(new Error(`fixture reader exited ${code}`)) })
    })
    run.stage = 'preview'
    const noRetry = new Store(home, join(home, 'profile'), config.maxStateBytes, resolveConfig({ stateWriteRetryCount: 0 }))
    await assert.rejects(noRetry.saveRun(run), error => error.code === 'EPERM' || error.code === 'EACCES')
    assert.equal((await store.readRun(run.id)).stage, undefined)
    release = setTimeout(() => child.stdin.end('\n'), 100)
    await store.saveRun(run)
    assert.equal((await store.readRun(run.id)).stage, 'preview')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).id, run.id)
  })

test('checkpoint retry budgets reject unbounded deployment values', () => {
  for (const value of [-1, 21, 0.5]) assert.throws(() => resolveConfig({ stateWriteRetryCount: value }))
  for (const value of [0, 1001, 0.5]) assert.throws(() => resolveConfig({ stateWriteRetryDelayMs: value }))
})

async function platformFiles(t) {
  const home = await mkdtemp(join(tmpdir(), 'afp-跨平台 空格-'))
  assert.equal(dirname(resolve(home)), resolve(tmpdir()))
  assert.ok(basename(home).startsWith('afp-跨平台 空格-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

for (const [platform, code] of [['win32', 'EPERM'], ['darwin', 'EBUSY'], ['darwin', 'EINTR'], ['linux', 'EBUSY']]) {
  test(`${platform} retries transient ${code} and replaces the same complete temporary record`, async t => {
    const home = await platformFiles(t), source = join(home, 'new.json.tmp'), destination = join(home, '记录.json')
    await writeFile(source, 'new\n', 'utf8'); await writeFile(destination, 'old\n', 'utf8')
    let attempts = 0
    await replaceRecordFile(source, destination, { platform, retries: 2, delayMs: 1,
      async renameFile(from, to) {
        assert.equal(await readFile(destination, 'utf8'), 'old\n')
        if (++attempts < 3) throw Object.assign(new Error('synthetic transient rename error'), { code })
        await rename(from, to)
      } })
    assert.equal(attempts, 3)
    assert.equal(await readFile(destination, 'utf8'), 'new\n')
  })
}

for (const code of ['EACCES', 'EPERM', 'ENOSPC']) {
  test(`macOS fails immediately on permanent ${code} and preserves both files`, async t => {
    const home = await platformFiles(t), source = join(home, 'new.tmp'), destination = join(home, '记录.json')
    await writeFile(source, 'new\n', 'utf8'); await writeFile(destination, 'old\n', 'utf8')
    const original = Object.assign(new Error('synthetic permanent rename error'), { code })
    let attempts = 0
    await assert.rejects(replaceRecordFile(source, destination, { platform: 'darwin', retries: 2, delayMs: 1,
      renameFile: async () => { attempts++; throw original } }), error => error === original)
    assert.equal(attempts, 1)
    assert.equal(await readFile(destination, 'utf8'), 'old\n')
    assert.equal(await readFile(source, 'utf8'), 'new\n')
  })
}

test('native record replacement respects platform reader lifetimes and Unicode paths', async t => {
  const home = await platformFiles(t), config = resolveConfig(), store = new Store(home, join(home, '测试 profile'), config.maxStateBytes, config)
  const run = await store.createRun(['food'], config), file = join(store.profile, 'runs', `${run.id}.json`)
  const reader = await open(file, 'r')
  let release
  try {
    run.stage = 'preview'
    if (process.platform === 'win32') {
      assert.equal(JSON.parse(await reader.readFile('utf8')).stage, undefined)
      // Windows 需要释放读句柄后才能替换；macOS 可继续从旧文件描述符读取。
      release = setTimeout(() => { void reader.close() }, 50)
    }
    await store.saveRun(run)
    if (process.platform !== 'win32') assert.equal(JSON.parse(await reader.readFile('utf8')).stage, undefined)
    assert.equal((await store.readRun(run.id)).stage, 'preview')
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  } finally { clearTimeout(release); await reader.close() }
})

test('profile storage refuses user-created directory links on every platform', async t => {
  const home = await platformFiles(t), target = join(home, '真实目录'), link = join(home, '链接目录')
  await mkdir(target)
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    const config = resolveConfig(), store = new Store(link, join(home, 'profile'), config.maxStateBytes, config)
    await assert.rejects(store.createRun(['food'], config), /refuses symlinks/)
  } finally { await unlink(link) }
})

for (const [platform, code] of [['win32', 'EPERM'], ['darwin', 'EINTR']]) {
  test(`${platform} stops at the rename retry budget and retains the previous record`, async t => {
    const home = await platformFiles(t), source = join(home, 'new.tmp'), destination = join(home, '记录.json')
    await writeFile(source, 'new\n', 'utf8'); await writeFile(destination, 'old\n', 'utf8')
    const original = Object.assign(new Error('synthetic persistent rename failure'), { code })
    let attempts = 0
    await assert.rejects(replaceRecordFile(source, destination, { platform, retries: 2, delayMs: 1,
      renameFile: async () => { attempts++; throw original } }), error => error === original)
    assert.equal(attempts, 3)
    assert.equal(await readFile(destination, 'utf8'), 'old\n')
    assert.equal(readFailure(original, 'checkpoint-save').code, 'checkpoint-save-failed')
    assert.equal(diagnosticFailure(original, 'checkpoint-save').systemCode, code)
  })
}
