import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { DEFAULT_PROFILE_BUNDLES, OPTIONAL_BUNDLES, PROFILE_TEMPLATES, composeEntries, initProfile, readPluginIcon, readProfileManifest } from '@deepseek-ai/dsh-app-boot'

const directory = fileURLToPath(new URL('../', import.meta.url))
const manifestSchema = z.object({
  name: z.literal('dsh-plugin-codex-subscription'), version: z.string().min(1), license: z.literal('MIT'),
  type: z.literal('module'), icon: z.string(), files: z.array(z.string()), exports: z.record(z.string(), z.string()), bin: z.never().optional(),
  dsh: z.object({ bundle: z.object({ patch: z.string(), features: z.array(z.object({ id: z.string(), rowId: z.string(), kind: z.literal('script'), defaultEnabled: z.boolean() })) }),
    client: z.never().optional() }),
})
const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')))

test('published metadata declares a Host-only bundle without a browser entry or application executable', async () => {
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './locale/*.json', './package.json', './tools'])
  assert.deepEqual(manifest.exports, { '.': './index.js', './tools': './tools.js', './package.json': './package.json', './locale/*.json': './locale/*.json' })
  for (const file of ['index.js', 'tools.js', 'cordis.patch.yml', 'icon.svg', 'locale', 'README.md', 'README.zh.md', 'THIRD_PARTY_NOTICES.md']) assert.ok(manifest.files.includes(file), `${file} must be shipped`)
  assert.equal(manifest.dsh.client, undefined)
  assert.ok(!manifest.files.includes('client.js'))
  assert.equal(manifest.bin, undefined)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.dsh.bundle.features.map(feature => ({ id: feature.id, rowId: feature.rowId, kind: feature.kind, enabled: feature.defaultEnabled })), [
    { id: 'image-tools', rowId: 'codex-subscription-tools', kind: 'script', enabled: true },
  ])
  for (const language of ['en', 'zh']) {
    const locale = z.object({ meta: z.object({ title: z.string().min(1), description: z.string().min(1) }) }).parse(JSON.parse(await readFile(join(directory, 'locale', `${language}.json`), 'utf8')))
    assert.ok(locale.meta.title)
  }
  assert.equal(readPluginIcon(manifest.icon, join(directory, 'package.json'))?.contentType, 'image/svg+xml')
})

test('the shipped bundle composes two addressable rows without experimental classification or default activation', async () => {
  const patches = z.array(z.object({ insert: z.array(z.object({ id: z.string(), name: z.string(), disabled: z.boolean().default(false) })) })).parse(JSON.parse(await readFile(join(directory, manifest.dsh.bundle.patch), 'utf8')))
  const rows = composeEntries([patches])
  assert.deepEqual(rows.map(row => ({ id: row.id, name: row.name })), [
    { id: 'codex-subscription', name: manifest.name }, { id: 'codex-subscription-tools', name: `${manifest.name}/tools` },
  ])
  assert.equal(rows.find(row => row.id === 'codex-subscription-tools')?.disabled, false)
  assert.ok(!OPTIONAL_BUNDLES.includes(manifest.name))
  const cli = z.object({ dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(await readFile(new URL('../../../../apps/cli/package.json', import.meta.url), 'utf8')))
  assert.equal(cli.dependencies[manifest.name], 'workspace:*')
  assert.ok(!DEFAULT_PROFILE_BUNDLES.includes(manifest.name))
  for (const template of Object.values(PROFILE_TEMPLATES)) assert.ok(!template.bundles.includes(manifest.name))
  const scratch = await mkdtemp(join(tmpdir(), 'codex-subscription-profile-'))
  try {
    initProfile(scratch, PROFILE_TEMPLATES.web!.bundles)
    const profile = readProfileManifest('distribution-test', scratch)
    assert.ok(!profile.dsh?.profile?.bundles?.includes(manifest.name))
  } finally {
    assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + sep))
    await rm(scratch, { recursive: true, force: true })
  }
})

test('paired user documentation and legal notices ship with fixed protocol attribution', async () => {
  const [english, chinese, notices] = await Promise.all(['README.md', 'README.zh.md', 'THIRD_PARTY_NOTICES.md'].map(file => readFile(join(directory, file), 'utf8')))
  assert.equal(english!.split('\n').length, chinese!.split('\n').length)
  for (const content of [english!, chinese!]) {
    for (const marker of ['autoflow-codex', '/mcp/image', '/v1/responses', 'outcome-unknown', '1455', '1457']) assert.ok(content.includes(marker), `Documentation must explain ${marker}`)
  }
  assert.ok(notices!.includes('e056779a67d2024a09aa25edad8a4373931a5b64'))
  assert.ok(notices!.includes('Copyright (c) 2026 yetone'))
  assert.ok(notices!.includes('Copyright (c) 2026 DeepSeek'))
  assert.ok(notices!.includes('THE SOFTWARE IS PROVIDED "AS IS"'))
})

// Artifact checks are opt-in so source tests also run on a clean checkout. Build before setting this flag.
test('built distribution resolves its declared entry files and exports only Loader members', { skip: process.env.DSH_CODEX_VERIFY_BUILT !== '1' }, async () => {
  for (const file of ['index.js', 'tools.js']) {
    await access(join(directory, file))
    assert.ok((await readFile(join(directory, file), 'utf8')).length > 0)
  }
  for (const entry of ['index.js', 'tools.js']) {
    const module: object = await import(new URL(`../${entry}`, import.meta.url).href)
    assert.deepEqual(Object.keys(module).sort(), ['Config', 'apply', 'inject', 'name'])
  }
  for (const exported of ['dsh-plugin-codex-subscription', 'dsh-plugin-codex-subscription/tools', 'dsh-plugin-codex-subscription/locale/en.json', 'dsh-plugin-codex-subscription/locale/zh.json']) {
    await access(fileURLToPath(import.meta.resolve(exported)))
  }
})
