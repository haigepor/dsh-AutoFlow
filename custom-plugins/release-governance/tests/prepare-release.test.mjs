/** Dirty-source rejection happens before tests, build, packaging or output creation. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { prepareRelease } from '../prepare-plugin-release.mjs'

test('formal preparation refuses dirty source without invoking package scripts or creating output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-release-source-'))
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
  }
  try {
    git(['init', '-q']); git(['config', 'user.name', 'Release fixture']); git(['config', 'user.email', 'release@example.invalid'])
    await writeFile(join(root, 'source.txt'), 'committed\n', 'utf8')
    git(['add', 'source.txt']); git(['commit', '-qm', 'fixture'])
    await writeFile(join(root, 'source.txt'), 'uncommitted\n', 'utf8')
    const output = join(root, 'out')
    await assert.rejects(prepareRelease({ packageRoot: root, expectedPackage: 'fixture-plugin', packageManager: process.execPath }, ['--out', output]), /Commit the intended changes/)
    await assert.rejects(access(output))
    assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'uncommitted\n')
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'dsh-plugin-release-source-'))
    await rm(root, { recursive: true, force: true })
  }
})
