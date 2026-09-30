import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const defaults = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
const rows = JSON.parse(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'))[0].insert
assert.equal(manifest.bin, undefined)
assert.equal(defaults.version, 1)
assert.equal(manifest.dsh.bundle.featureConfig, './config.json')
for (const filename of readdirSync(join(root, 'locale'))) assert.match(filename, /^[a-z]{2,3}(?:-[a-z0-9]+)*\.json$/, 'Metadata locale filenames must be language IDs')
assert.equal(new Set(manifest.dsh.bundle.features.map(feature => feature.id)).size, manifest.dsh.bundle.features.length)
for (const feature of manifest.dsh.bundle.features) {
  const matched = rows.filter(row => row.id === feature.rowId)
  assert.equal(matched.length, 1)
  assert.equal(matched[0].disabled, !feature.defaultEnabled)
  assert.equal(defaults.features[feature.id], feature.defaultEnabled)
}
for (const target of Object.values(manifest.exports)) assert.ok(existsSync(resolve(root, target.replace('*.json', 'zh.json'))), `Missing export: ${target}`)
for (const file of ['README.md', 'README.zh.md', 'UPSTREAM.md', 'cli/afp-task.js']) assert.ok(existsSync(join(root, file)), `Missing ${file}`)
function check(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== 'node_modules') check(file)
    if (!entry.isFile() || !/\.(js|mjs|md|json|css|svg|yml)$/.test(file)) continue
    const text = new TextDecoder('utf8', { fatal: true }).decode(readFileSync(file))
    assert.ok(!text.includes('\uFFFD') && !text.startsWith('\uFEFF'), `Invalid encoding: ${file}`)
    if (/\.(js|mjs)$/.test(file)) assert.equal(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status, 0, file)
    if (file.endsWith('.json')) JSON.parse(text)
    if (file.includes(join(root, 'skills') + '/') || file.includes(join(root, 'skills') + '\\')) assert.ok(!/\.env|\.runtime\/|[DC]:[\\/]/.test(text), `External runtime reference: ${file}`)
  }
}
check(root)
console.log('AFP package files, exports, features, syntax and UTF-8 checks passed.')
