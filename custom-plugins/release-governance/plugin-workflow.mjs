/** Stable GitHub publication and fast local packaging through the existing product workflows. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as pause } from 'node:timers/promises'
import { gt } from 'semver'
import { releaseMetadata } from './prepare-plugin-release.mjs'
import { packLocalPlugin, progress } from './local-package.mjs'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const products = ['dsh-plugin-afp', 'dsh-plugin-codex-subscription', 'dsh-plugin-visual-curator', 'dsh-plugin-style-prompt', 'dsh-boot-animation']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function git(args) {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, `Git ${args[0]} failed: ${result.stderr || result.error?.message || ''}`)
  return result.stdout.trim()
}

function githubClient() {
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) {
    const credential = spawnSync('git', ['credential', 'fill'], { cwd: repositoryRoot, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true, timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } })
    token = credential.status === 0 ? credential.stdout.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9) : undefined
  }
  assert.ok(token, '请先登录 Git Credential Manager，或设置 GH_TOKEN / GITHUB_TOKEN；发布需要 Contents 与 Actions 写权限')
  return async (method, path, body) => {
    const target = new URL(path, 'https://api.github.com')
    assert.equal(target.origin, 'https://api.github.com')
    const response = await fetch(target, { method, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'AutoFlow-plugin-workflow',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (method === 'GET' && response.status === 404) return undefined
    assert.ok(response.ok, `GitHub ${method} ${target.pathname}: HTTP ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
}

async function publicBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), credentials: 'omit', headers: { 'Cache-Control': 'no-cache' } })
  if (response.status === 404) return undefined
  assert.ok(response.ok, `公开更新文件读取失败：HTTP ${response.status}`)
  let length = 0
  const chunks = []
  for await (const chunk of response.body) {
    length += chunk.length
    assert.ok(length <= 1024 * 1024, 'Update document exceeds 1 MiB')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Verify the exact stable metadata and three required public assets without downloading the archive again.
 * @param {object} manifest Source manifest. @param {object} config Release configuration.
 * @param {string} sourceCommit Frozen tag commit. @param {object} release Public Release response.
 * @param {Buffer} bytes Public metadata bytes. @returns {object} Metadata verified against GitHub asset digests.
 */
export function verifyStableAssets(manifest, config, sourceCommit, release, bytes) {
  const metadata = JSON.parse(bytes.toString('utf8'))
  const expected = releaseMetadata(manifest, config, { tag: metadata.tag, sha256: metadata.asset.sha256, size: metadata.asset.size, sourceCommit, sourceDirty: false }, manifest.name)
  assert.deepEqual(metadata, expected, 'Published metadata differs from the frozen source')
  assert.equal(release.tag_name, expected.tag)
  assert.equal(release.draft, false); assert.equal(release.prerelease, false)
  assert.equal(release.html_url, `https://github.com/${config.repository}/releases/tag/${expected.tag}`)
  const asset = name => {
    const item = release.assets.find(row => row.name === name)
    assert.ok(item?.state === 'uploaded', `Missing published asset: ${name}`)
    assert.equal(item.browser_download_url, `https://github.com/${config.repository}/releases/download/${expected.tag}/${name}`)
    return item
  }
  const json = asset(config.metadataAsset), archive = asset(expected.asset.name), sums = asset('SHA256SUMS')
  assert.equal(json.size, bytes.length); assert.equal(json.digest, `sha256:${sha256(bytes)}`)
  assert.equal(archive.size, expected.asset.size); assert.equal(archive.digest, `sha256:${expected.asset.sha256}`)
  const checksum = Buffer.from(`${expected.asset.sha256}  ${expected.asset.name}\n`)
  assert.equal(sums.size, checksum.length); assert.equal(sums.digest, `sha256:${sha256(checksum)}`)
  return expected
}

/** Freeze a stable tag, follow native Actions, and wait for the anonymous official update index.
 * @param {object} options Manifest, release config, sourceCommit, retry and timeoutMs.
 * @param {Function} api Authenticated GitHub JSON transport.
 * @param {object} dependencies Optional public reader, progress reporter and polling delay.
 * @returns {Promise<object>} Public release metadata, Release URL and deployed index URL.
 */
export async function publishStablePlugin({ manifest, config, sourceCommit, retry = false, timeoutMs = 60 * 60_000 }, api,
  { readPublic = publicBytes, report = console.log, wait = pause } = {}) {
  const tag = `${config.tagPrefix}${manifest.version}`, root = `/repos/${config.repository}`
  releaseMetadata(manifest, config, { tag, sourceCommit, sourceDirty: false, sha256: '0'.repeat(64), size: 1 }, manifest.name)
  const workflow = manifest.name === 'dsh-plugin-afp' ? 'release-afp.yml' : 'release-custom-plugins.yml'
  const deadline = Date.now() + timeoutMs
  const poll = async () => { assert.ok(Date.now() < deadline, `等待超时；可重新运行以继续检查： https://github.com/${config.repository}/actions`); await wait(10_000) }
  let reference = await api('GET', `${root}/git/ref/tags/${tag}`)
  for (let depth = 0; reference?.object.type === 'tag' && depth < 4; depth++) reference = await api('GET', `${root}/git/tags/${reference.object.sha}`)
  if (reference) assert.ok(reference.object.type === 'commit' && reference.object.sha === sourceCommit, '已有标签指向不同源码；禁止移动正式标签，请升版')
  let release = await api('GET', `${root}/releases/tags/${tag}`)
  assert.ok(!release || reference, 'Published Release has no matching immutable source tag')
  let run
  if (!release || release.draft) {
    if (!reference) {
      report(`[2/4] 创建正式标签 ${tag} → ${sourceCommit}`)
      await api('POST', `${root}/git/refs`, { ref: `refs/tags/${tag}`, sha: sourceCommit })
    }
    const findRun = async () => (await api('GET', `${root}/actions/workflows/${workflow}/runs?head_sha=${sourceCommit}&per_page=100`)).workflow_runs
      .find(row => row.head_sha === sourceCommit && row.head_branch === tag)
    run = await findRun()
    // Tag push normally starts Actions; give GitHub time before dispatching a missing run.
    for (let attempt = 0; !run && !reference && attempt < 3; attempt++) { await poll(); run = await findRun() }
    if (!run) {
      report(`  启动 ${workflow} · ${tag}`)
      await api('POST', `${root}/actions/workflows/${workflow}/dispatches`, { ref: tag, inputs: { tag } })
      while (!run) { await poll(); run = await findRun() }
    } else if (run.status === 'completed' && run.conclusion !== 'success') {
      assert.ok(retry, `发布任务失败：${run.html_url}；临时故障可加 --retry 重跑，修改插件源码须使用新版本与标签`)
      const previousAttempt = run.run_attempt
      await api('POST', `${root}/actions/runs/${run.id}/rerun-failed-jobs`)
      do { await poll(); run = await api('GET', `${root}/actions/runs/${run.id}`) } while (run.status === 'completed' && run.run_attempt === previousAttempt)
    }
    report(`  构建进度：${run.html_url}`)
    let previous = ''
    while (run.status !== 'completed') {
      const jobs = (await api('GET', `${root}/actions/runs/${run.id}/jobs?per_page=100`)).jobs
      const state = jobs.map(job => `${job.name}: ${job.conclusion ?? job.status}`).join(' | ')
      if (state !== previous) { report(`  ${state}`); previous = state }
      await poll()
      run = await api('GET', `${root}/actions/runs/${run.id}`)
    }
    assert.equal(run.conclusion, 'success', `发布失败，保留原标签与资产：${run.html_url}`)
    release = await api('GET', `${root}/releases/tags/${tag}`)
  }
  report('[3/4] 验证公开 Release、源码与资产摘要')
  assert.ok(release && !release.draft, `尚无公开正式资产：https://github.com/${config.repository}/releases/tag/${tag}`)
  const bytes = await readPublic(`https://github.com/${config.repository}/releases/download/${tag}/${config.metadataAsset}`)
  assert.ok(bytes, '公开元数据不可用；保留已发布资产并重试')
  const metadata = verifyStableAssets(manifest, config, sourceCommit, release, bytes)
  const [owner, project] = config.repository.split('/')
  const indexUrl = `https://${owner}.github.io/${project}/plugins/stable/index.json`
  report(`[4/4] 等待官方更新索引：${indexUrl}`)
  if (retry) {
    const repository = await api('GET', root)
    await api('POST', `${root}/actions/workflows/plugin-update-index.yml/dispatches`, { ref: repository.default_branch })
  }
  while (true) {
    const document = await readPublic(indexUrl)
    if (document) {
      const index = JSON.parse(document.toString('utf8'))
      assert.equal(index.schemaVersion, 1); assert.equal(index.repository, config.repository)
      const entry = index.plugins.find(item => item.package === manifest.name)
      if (entry?.version === metadata.version) { assert.deepEqual(entry, metadata, '官方索引与公开资产不一致'); break }
      if (entry) assert.ok(gt(manifest.version, entry.version), '已有更高正式版本；请勿发布较旧版本')
    }
    await poll()
  }
  return { ...metadata, release: release.html_url, indexUrl, workflow: run?.html_url }
}

/** @param {string[]} args Product name and CLI flags. @returns {Promise<object|undefined>} Stable publication or local archive receipt; never commits, pushes a branch, installs or restarts an app. */
export async function runPluginWorkflow(args = process.argv.slice(2)) {
  const [product, ...flags] = args
  assert.ok(products.includes(product), 'Select a supported independent plugin package')
  const { values } = parseArgs({ args: flags.filter(flag => flag !== '--'), options: {
    local: { type: 'boolean' }, help: { type: 'boolean' }, plan: { type: 'boolean' }, retry: { type: 'boolean' }, out: { type: 'string' },
    'full-checks': { type: 'boolean' }, 'prepare-only': { type: 'boolean' }, 'allow-dirty': { type: 'boolean' }, 'timeout-minutes': { type: 'string', default: '60' },
  } })
  if (values.help) {
    console.log(`pnpm run ${product}               正式 GitHub 发布：已升版、提交并推送的干净源码 → 原生 Actions → 官方更新索引\npnpm run ${product}:local         本地快速打包：允许未提交修改，不访问 GitHub、不安装、不重启\n  --plan                         只显示发布计划，不访问 GitHub\n  --retry                        重跑失败的远程任务，并修复更新索引\n  --timeout-minutes <number>      发布等待上限，默认 60 分钟\n  :local --out <directory>        本地产物根目录，每次生成唯一版本子目录\n  :local --full-checks            额外运行插件 check 与 test\n  旧 --prepare-only [--allow-dirty] 等同 :local；正式发布不接受脏树。`)
    return
  }
  const local = values.local || values['prepare-only']
  assert.ok(!values['allow-dirty'] || local, '--allow-dirty 仅用于本地打包；请使用 :local')
  assert.ok(local || (!values.out && !values['full-checks']), '--out / --full-checks 仅用于 :local')
  assert.ok(!local || (!values.retry && !values.plan), '--retry / --plan 仅用于正式发布')
  const packageRoot = join(repositoryRoot, 'custom-plugins/workspace', product)
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const config = JSON.parse(await readFile(join(packageRoot, 'release.config.json'), 'utf8'))
  const sourceCommit = git(['rev-parse', 'HEAD']), sourceDirty = git(['status', '--porcelain']) !== ''
  const tag = `${config.tagPrefix}${manifest.version}`
  releaseMetadata(manifest, config, { tag, sourceCommit, sourceDirty, sha256: '0'.repeat(64), size: 1 }, product)
  if (local) {
    if (values['prepare-only']) console.log('旧参数已映射为本地打包；建议下次直接使用 :local。')
    return packLocalPlugin({ packageRoot, repositoryRoot, manifest, sourceCommit, sourceDirty, outputRoot: values.out ? resolve(repositoryRoot, values.out) : undefined, fullChecks: values['full-checks'] })
  }
  if (values.plan) { console.log(`正式发布计划（未执行）\n${product} ${manifest.version}\n标签 ${tag}\n源码 ${sourceCommit}\n工作区 ${sourceDirty ? '有未提交修改，正式发布会拒绝' : '干净'}\n仓库 ${config.repository}\n发布完成后等待官方稳定索引；不自动升版、提交或推送分支。`); return }
  const minutes = Number(values['timeout-minutes'])
  assert.ok(Number.isInteger(minutes) && minutes >= 1 && minutes <= 180, 'Invalid release timeout (1–180 minutes)')
  await progress('[1/4] 检查正式版本、源码与推送状态', async () => {
    assert.ok(!sourceDirty, '请先更新插件稳定版本及发布说明，再提交并推送全部预期修改；快速本地测试请用 :local')
    const origin = git(['remote', 'get-url', 'origin']).replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
    assert.ok(origin.toLowerCase() === `https://github.com/${config.repository}`.toLowerCase(), 'Origin differs from the release repository')
  })
  const api = githubClient(), repository = await api('GET', `/repos/${config.repository}`)
  assert.ok(repository?.permissions?.push, 'GitHub credential lacks repository write permission')
  const branch = git(['branch', '--show-current'])
  assert.ok(branch, '正式发布需要已推送分支，不接受 detached HEAD')
  const remote = await api('GET', `/repos/${config.repository}/git/ref/heads/${encodeURIComponent(branch)}`)
  assert.equal(remote?.object.sha, sourceCommit, '远端分支与 HEAD 不一致，请先推送')
  const result = await progress('[2–4/4] 跟踪正式发布与远程更新', () => publishStablePlugin({ manifest, config, sourceCommit, retry: values.retry, timeoutMs: minutes * 60_000 }, api))
  console.log(`\n正式版与远程更新已就绪\n${result.release}\n${result.asset.url}\n版本 ${result.version}\n源码 ${result.sourceCommit}\nSHA256 ${result.asset.sha256}\n官方索引 ${result.indexUrl}`)
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runPluginWorkflow() } catch (error) { console.error(`\n操作失败：${error.message}`); process.exitCode = 1 }
}
