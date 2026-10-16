/** Verify package entries, capability declarations, locale parity and UTF-8. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'))
const manifest = read('package.json'), rows = read('cordis.patch.yml')[0].insert, config = read('config.json')
assert.equal(manifest.bin, undefined)
assert.equal(new Set(rows.map(row => row.id)).size, rows.length)
for (const feature of manifest.dsh.bundle.features) {
  const row = rows.find(row => row.id === feature.rowId)
  assert.ok(row); assert.equal(row.disabled, !feature.defaultEnabled); assert.equal(config.features[feature.id], feature.defaultEnabled)
}
for (const target of Object.values(manifest.exports)) assert.ok(existsSync(join(root, target.replace('*.json', 'zh.json'))), target)
assert.deepEqual(Object.keys(read('src/client/locales/en.json')).sort(), Object.keys(read('src/client/locales/zh.json')).sort())
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.artifacts'].includes(entry.name)) continue
    const file = join(directory, entry.name)
    if (entry.isDirectory()) { check(file); continue }
    if (!/\.(js|mjs|md|json|css|svg|yml|csv)$/.test(file)) continue
    const bytes = readFileSync(file), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    assert.ok(!text.includes('\uFFFD') && !(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191), file)
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), `Expected one trailing newline: ${file}`)
    if (/\.(js|mjs)$/.test(file)) assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0, file)
  }
}
check(root)
console.log('Article image entries, features, locales, syntax and UTF-8 passed')
