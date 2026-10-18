/** Pack and load production dependencies in an isolated directory without workspace links. */
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const pnpmCli = process.argv[2] ?? process.env.npm_execpath
if (!pnpmCli || !/pnpm\.(?:c?js)$/i.test(pnpmCli)) throw new Error('Pass the absolute pnpm.cjs path as the first argument')
const packages = new Map()
async function manifest(path) {
  try { const value = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')); packages.set(value.name, { path, value }) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
for (const group of await readdir(join(repository, 'packages'), { withFileTypes: true })) {
  if (group.isDirectory()) for (const item of await readdir(join(repository, 'packages', group.name), { withFileTypes: true })) if (item.isDirectory()) await manifest(join(repository, 'packages', group.name, item.name))
}
for (const item of await readdir(join(repository, 'vendor'), { withFileTypes: true })) if (item.isDirectory()) await manifest(join(repository, 'vendor', item.name))
await manifest(resolve(repository, 'custom-plugins/workspace/dsh-plugin-article-image'))
await manifest(resolve(repository, 'custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit'))
const selected = new Map()
function select(name) {
  if (selected.has(name) || !packages.has(name)) return
  const entry = packages.get(name); selected.set(name, entry)
  for (const dependency of Object.keys(entry.value.dependencies ?? {})) select(dependency)
  for (const dependency of Object.keys(entry.value.peerDependencies ?? {})) if (!entry.value.peerDependenciesMeta?.[dependency]?.optional) select(dependency)
}
select('dsh-plugin-article-image')
const directory = await mkdtemp(join(tmpdir(), 'article-image-production-')), packed = join(directory, 'packed'), installed = join(directory, 'installed')
await mkdir(packed); await mkdir(installed)
const execute = (args, cwd, env = {}) => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180000, windowsHide: true })
  if (result.status !== 0) throw new Error(`${args.slice(0, 3).join(' ')} failed: ${result.stderr}\n${result.stdout}`)
}
try {
  const dependencies = {}
  for (const [name, entry] of selected) {
    execute([pnpmCli, '--dir', entry.path, 'pack', '--pack-destination', packed], repository, { npm_config_ignore_scripts: 'true' })
    const filename = `${name.replace(/^@/, '').replaceAll('/', '-')}-${entry.value.version}.tgz`
    dependencies[name] = `file:${join(packed, filename).replaceAll('\\', '/')}`
  }
  await writeFile(join(installed, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }) + '\n', 'utf8')
  const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  execute([npmCli, 'install', '--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], installed)
  const probe = `
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import * as plugin from 'dsh-plugin-article-image'
import { createCapture, resolveCaptureConfig } from 'article-image-toolkit/capture'
const packageRoot = new URL('./node_modules/dsh-plugin-article-image/', import.meta.url)
const { loadEditorialRules, resolveAnalysisConfig } = await import(new URL('src/host/editorial-rules.js', packageRoot))
assert.ok((await loadEditorialRules(resolveAnalysisConfig())).rulesHash)
assert.ok((await readFile(new URL('client.js', packageRoot))).length > 1000)
assert.ok((await readFile(new URL('skills/article-image-editorial-prompts/SKILL.md', packageRoot), 'utf8')).includes('references'))
const capture = createCapture(resolveCaptureConfig())
assert.equal((await capture.readiness()).available, true)
await capture.dispose()
const missing = createCapture(resolveCaptureConfig(), { loadChromium: async () => ({ launch: async () => { throw new Error('fixture browser missing') } }) })
assert.equal((await missing.readiness()).code, 'article-render-unavailable')
await missing.dispose()
const ctx = new Context()
ctx.provide('profileContext', { home: fileURLToPath(new URL('./home', import.meta.url)), dir: fileURLToPath(new URL('./profile', import.meta.url)) })
ctx.provide('pluginManager', { registerAction: () => () => {} })
ctx.provide('jobs', { attachController: () => () => {} })
ctx.provide('web', {})
await ctx.plugin(plugin)
assert.ok(ctx.get('articleImage'))
assert.equal((await ctx.get('articleImage').list()).total, 0)
const { registerTools } = await import(new URL('src/host/tools.js', packageRoot))
const names = []
registerTools({ effect: run => run(), tools: { register: tool => {
  names.push(tool.name)
  if (tool.name === 'article_image_plan_page') assert.ok(tool.parameters.required.includes('revision'))
  return () => {}
} } }, ctx.get('articleImage'))
assert.ok(names.includes('article_image_plan_page'))
assert.ok(!names.some(name => /approve|generate|publish|upload|writeback/.test(name)))
await ctx.fiber.dispose()
console.log('Production tarballs: rules, templates, client, shared kernel, Host load, browser ready/missing passed')
`
  await writeFile(join(installed, 'probe.mjs'), probe, 'utf8')
  const result = spawnSync(process.execPath, ['probe.mjs'], { cwd: installed, encoding: 'utf8', timeout: 60000, windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr + result.stdout)
  console.log(result.stdout.trim()); console.log(`Packed local production packages: ${selected.size}`)
} finally {
  if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\') && !resolve(directory).startsWith(resolve(tmpdir()) + '/')) throw new Error('Unexpected temporary directory')
  await rm(directory, { recursive: true, force: true })
}
