/** Publish immutable Desktop attachments before advancing the dedicated GitHub Pages branch. */
import { spawnSync } from 'node:child_process'
import { openAsBlob } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { prerelease } from 'semver'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { prepareDesktopGithubPublication, type DesktopGithubPublication } from './desktop-github-publication.ts'
import type { DesktopPolicyTarget } from '../src/static-update-policy.ts'

const PAGES_BRANCH = 'desktop-updates'

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('desktop GitHub: unexpected API response')
  return value as Record<string, unknown>
}

function token(repository: string): string {
  const configured = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (configured?.trim()) return configured.trim()
  const credential = spawnSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=github.com\npath=${repository}.git\n\n`,
    encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } })
  const password = credential.status === 0 ? credential.stdout.split(/\r?\n/u).find(line => line.startsWith('password='))?.slice(9) : undefined
  if (!password) throw new Error('desktop GitHub: configure GITHUB_TOKEN or authenticate Git Credential Manager')
  return password
}

/**
 * Publish a validated release and atomically advance policy and feed files after public downloads exist.
 * @param plan Verified local assets and policy metadata.
 * @param previousHead Pages branch SHA observed while reading the preceding policy, or undefined for its first publication.
 * @param request Authenticated GitHub API transport; replaceable at the publication test boundary.
 * @param publicRequest Anonymous HTTP transport for installer availability checks.
 * @returns Published Release and Pages policy URLs.
 */
export async function publishDesktopGithub(plan: DesktopGithubPublication, previousHead: string | undefined,
  request: (path: string, method?: string, body?: unknown) => Promise<unknown>, publicRequest: typeof fetch = fetch,
): Promise<{ release: string; policy: string }> {
  if (plan.dirty) throw new Error('desktop GitHub: publish requires artifacts built from a clean committed checkout')
  const prefix = `/repos/${plan.repository}`
  const repository = object(await request(prefix))
  if (repository.private !== false) throw new Error('desktop GitHub: desktop updates require a public repository')
  // 已有文档站点不能被桌面更新站点覆盖；只有专用发布分支由此脚本管理。
  const pages = await request(`${prefix}/pages`)
  const expectedRoot = `https://${plan.repository.split('/')[0]}.github.io/${plan.repository.split('/')[1]}/`
  if (!plan.pagesUrl.startsWith(expectedRoot)) throw new Error('desktop GitHub: Pages URL must use this repository project site')
  if (pages !== undefined) {
    const currentPages = object(pages)
    const source = object(currentPages.source)
    if (source.branch !== PAGES_BRANCH || source.path !== '/') throw new Error('desktop GitHub: existing Pages site is not the dedicated desktop-updates branch')
  }
  const refPath = `${prefix}/git/refs/heads/${PAGES_BRANCH}`
  const currentRef = await request(refPath)
  const currentHead = currentRef === undefined ? undefined : object(object(currentRef).object).sha
  if (currentHead !== previousHead) throw new Error('desktop GitHub: Pages branch moved; reconcile before publishing')
  const tagRef = await request(`${prefix}/git/refs/tags/${plan.tag}`)
  if (tagRef === undefined) await request(`${prefix}/git/refs`, 'POST', { ref: `refs/tags/${plan.tag}`, sha: plan.commit })
  else if (object(object(tagRef).object).sha !== plan.commit) throw new Error('desktop GitHub: release tag names a different commit')
  const existing = await request(`${prefix}/releases/tags/${encodeURIComponent(plan.tag)}`)
  let release = existing === undefined ? object(await request(`${prefix}/releases`, 'POST', {
    tag_name: plan.tag, target_commitish: plan.commit, name: `AutoFlow Desktop ${plan.version}${plan.signing === 'unsigned' ? '（无签名测试版）' : ''}`,
    body: `桌面完整安装包，包含对应 dsh 运行时和 AFP 插件。\n\n${plan.signing === 'unsigned' ? '此版本未进行代码签名，仅用于无签名测试通道。' : '此版本使用发布环境完成签名。'}\n\n构建提交：${plan.commit}`,
    draft: true, prerelease: plan.signing === 'unsigned' || prerelease(plan.version) !== null, make_latest: 'false',
  })) : object(existing)
  if (typeof release.id !== 'number' || !Array.isArray(release.assets)) throw new Error('desktop GitHub: invalid release')
  for (const asset of plan.assets) {
    const found = release.assets.map(object).find(remote => remote.name === asset.name)
    if (found !== undefined) {
      if (found.size !== asset.size || found.digest !== `sha256:${asset.sha256}`) throw new Error('desktop GitHub: existing immutable attachment differs')
      continue
    }
    if (release.draft !== true) throw new Error('desktop GitHub: cannot add attachments to an already published release')
    const remote = object(await request(`https://uploads.github.com${prefix}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,
      'POST', await openAsBlob(asset.path)))
    if (remote.size !== asset.size || remote.digest !== `sha256:${asset.sha256}`) throw new Error('desktop GitHub: uploaded attachment checksum differs')
  }
  if (release.draft === true) release = object(await request(`${prefix}/releases/${release.id}`, 'PATCH', { draft: false, make_latest: 'false' }))
  for (const asset of plan.assets) {
    const response = await publicRequest(`https://github.com/${plan.repository}/releases/download/${plan.tag}/${encodeURIComponent(asset.name)}`,
      { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(60000) })
    if (!response.ok || Number(response.headers.get('content-length')) !== asset.size) throw new Error('desktop GitHub: attachment is not publicly downloadable')
  }
  const sitePrefix = plan.pagesUrl.slice(expectedRoot.length)
  const files = { '.nojekyll': '', [`${sitePrefix}policy.json`]: `${JSON.stringify(plan.policy, null, 2)}\n`,
    [`${sitePrefix}feeds/${plan.target}/${plan.feedName}`]: plan.feed }
  const tree: { path: string; mode: string; type: string; sha: unknown }[] = []
  for (const [path, content] of Object.entries(files)) {
    const blob = object(await request(`${prefix}/git/blobs`, 'POST', { content, encoding: 'utf-8' }))
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
  }
  const previous = previousHead === undefined ? undefined : object(await request(`${prefix}/git/commits/${previousHead}`))
  const baseTree = previous === undefined ? undefined : object(previous.tree).sha
  const resultTree = object(await request(`${prefix}/git/trees`, 'POST', { ...(baseTree === undefined ? {} : { base_tree: baseTree }), tree }))
  const commit = object(await request(`${prefix}/git/commits`, 'POST', { message: `发布桌面更新：${plan.target} ${plan.version}`,
    tree: resultTree.sha, parents: previousHead === undefined ? [] : [previousHead] }))
  if (previousHead === undefined) await request(`${prefix}/git/refs`, 'POST', { ref: `refs/heads/${PAGES_BRANCH}`, sha: commit.sha })
  else await request(refPath, 'PATCH', { sha: commit.sha, force: false })
  if (pages === undefined) await request(`${prefix}/pages`, 'POST', { source: { branch: PAGES_BRANCH, path: '/' } })
  await request(`${prefix}/pages/builds`, 'POST')
  return { release: String(release.html_url), policy: `${plan.pagesUrl}policy.json` }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    'prepare-only': { type: 'boolean' }, 'minimum-supported-version': { type: 'string' }, out: { type: 'string' },
  } })
  const name = positionals[0]
  if (positionals.length !== 1 || (name !== 'win-x64' && name !== 'mac-x64' && name !== 'mac-arm64')) throw new Error('desktop GitHub: choose win-x64, mac-x64 or mac-arm64')
  const target: DesktopPolicyTarget = name
  const env = loadDesktopPackageEnvironment(target === 'win-x64' ? 'win32' : 'darwin')
  const repository = env.DSH_DESKTOP_GITHUB_REPOSITORY
  if (!repository) throw new Error('desktop GitHub: configure DSH_DESKTOP_GITHUB_REPOSITORY')
  const secret = token(repository)
  const request = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    const response = await fetch(path.startsWith('https://uploads.github.com/') ? path : `https://api.github.com${path}`, {
      method, headers: { authorization: `Bearer ${secret}`, accept: 'application/vnd.github+json',
        'content-type': body instanceof Blob ? 'application/octet-stream' : 'application/json' },
      ...(body === undefined ? {} : { body: body instanceof Blob ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(body instanceof Blob ? 1800000 : 60000),
    })
    if (response.status === 404 && method === 'GET') return undefined
    if (!response.ok) throw new Error(`desktop GitHub: API ${method} failed with status ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  const prefix = `/repos/${repository}`
  const branch = await request(`${prefix}/git/refs/heads/${PAGES_BRANCH}`)
  const head = branch === undefined ? undefined : object(object(branch).object).sha
  if (head !== undefined && typeof head !== 'string') throw new Error('desktop GitHub: invalid Pages branch')
  const pagesUrl = env.DSH_DESKTOP_GITHUB_PAGES_URL ?? ''
  const expectedRoot = `https://${repository.split('/')[0]}.github.io/${repository.split('/')[1]}/`
  if (!pagesUrl.startsWith(expectedRoot)) throw new Error('desktop GitHub: Pages URL must use this repository project site')
  const sitePrefix = pagesUrl.slice(expectedRoot.length)
  const oldFile = head === undefined ? undefined : await request(`${prefix}/contents/${sitePrefix}policy.json?ref=${head}`)
  const old = oldFile === undefined ? undefined : JSON.parse(Buffer.from(String(object(oldFile).content), 'base64').toString('utf8')) as unknown
  const product = object(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')))
  if (typeof product.version !== 'string') throw new Error('desktop GitHub: missing product version')
  const paths = desktopTargetBuildPaths(target)
  const plan = await prepareDesktopGithubPublication(target, { environment: env, productVersion: product.version,
    artifactsRoot: env.DSH_DESKTOP_UNSIGNED_UPDATES === '1' ? paths.unsignedArtifacts : paths.artifacts,
    previousPolicy: old, ...(values['minimum-supported-version'] === undefined ? {}
      : { minimumSupportedVersion: values['minimum-supported-version'] }) })
  const output = resolve(values.out ?? join(paths.root, 'github-publication'))
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'policy.json'), `${JSON.stringify(plan.policy, null, 2)}\n`, 'utf8')
  await writeFile(join(output, plan.feedName), plan.feed, 'utf8')
  await writeFile(join(output, 'publication.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  if (values['prepare-only']) { process.stdout.write(`desktop GitHub: validated publication at ${output}\n`); return }
  const result = await publishDesktopGithub(plan, head, request)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'desktop GitHub: failed'}\n`); process.exitCode = 1 })
}
