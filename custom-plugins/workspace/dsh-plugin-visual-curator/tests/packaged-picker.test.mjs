/** Released hosts may resolve the older public picker package from profile dependencies. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('built plugin entries load with the public folder-only picker and ship their own image dialog worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-packaged-picker-'))
  const plugin = fileURLToPath(new URL('../', import.meta.url))
  try {
    const built = spawnSync(process.execPath, ['scripts/build.mjs', '--outdir', root], { cwd: plugin, encoding: 'utf8' })
    assert.equal(built.status, 0, built.stderr)
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n', 'utf8')
    await symlink(join(plugin, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(root, 'old-picker.mjs'), 'export function pickNativeDirectory() { return null }\n', 'utf8')
    await writeFile(join(root, 'load.mjs'), `
import { registerHooks } from 'node:module';
import { access } from 'node:fs/promises';
import assert from 'node:assert/strict';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-host-directory-picker-native') return { url: new URL('./old-picker.mjs', import.meta.url).href, shortCircuit: true };
  if (specifier === '@deepseek-ai/dsh-native-command') throw new Error('Native command helper must be bundled for older hosts');
  return next(specifier, context);
} });
for (const entry of ['index', 'tools', 'skill', 'page']) {
  const module = await import('./'+entry+'.js');
  assert.equal(typeof module.apply, 'function');
}
await access(new URL('./worker.cjs', import.meta.url));
console.log('PACKAGED_ENTRIES_READY');
`, 'utf8')
    const loaded = spawnSync(process.execPath, [join(root, 'load.mjs')], { cwd: root, encoding: 'utf8' })
    assert.equal(loaded.status, 0, loaded.stderr)
    assert.match(loaded.stdout, /PACKAGED_ENTRIES_READY/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
