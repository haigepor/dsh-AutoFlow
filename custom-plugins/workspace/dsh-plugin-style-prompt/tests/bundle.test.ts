/** Loader behavior is exercised without pretending that direct service construction mounts a bundle. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as entry from '../src/host/plugin.ts'
import { readPluginMeta, readProfileManifest, bundlePatchPaths, loadOverlayPatches, composeEntries } from '@deepseek-ai/dsh-app-boot'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

test('the shipped configuration accepts an omitted row config and resolves its explicit defaults', () => {
  const config = entry.Config.parse(undefined)
  assert.equal(config.maxImages, 4)
  assert.equal(config.requestTimeoutMs, 180_000)
})

test('the Host entry exposes exactly the function-plugin Loader fields', () => {
  assert.deepEqual(Object.keys(entry).sort(), ['Config', 'apply', 'inject', 'name'])
  assert.equal('default' in entry, false)
})

test('native plugin inventory reads translated titles and a shipped image without executing the Host', () => {
  const meta = readPluginMeta('dsh-plugin-style-prompt', import.meta.url)
  const title = meta?.title
  assert.ok(title && typeof title === 'object')
  assert.equal(title.zh, '风格提示词')
  assert.equal(title.en, 'Style Prompt')
  assert.match(meta?.icon ?? '', /^data:image\/webp;base64,/)
  assert.equal(meta?.error, undefined)
})

test('the shipped workbench declares the manageable feature required by the installed plugin list', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const manifest = readProfileManifest('dsh', root), bundle = manifest.dsh?.bundle
  assert.ok(bundle)
  const feature = bundle.features?.find(item => item.id === 'workbench')
  assert.ok(feature)
  assert.equal(feature.kind, 'ui')
  assert.equal(feature.defaultEnabled, true)
  const rows = composeEntries([bundlePatchPaths(root, bundle).flatMap(file => loadOverlayPatches('dsh', file))])
  assert.ok(rows.some(row => row.id === feature.rowId && row.disabled !== true))
})

test('the application carries Style Prompt as a production dependency', async () => {
  const text = await readFile(new URL('../../../../apps/cli/package.json', import.meta.url), 'utf8')
  const manifest = z.object({ dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(text))
  assert.equal(manifest.dependencies['dsh-plugin-style-prompt'], 'workspace:*')
})
