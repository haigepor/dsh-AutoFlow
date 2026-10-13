import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { resolveBundleDir, resolveBundleUpdateManager } from '../src/profile.ts'

it('rejects an updater target outside the package-name grammar before filesystem lookup', () => {
  expect(() => resolveBundleUpdateManager('../custom-sidebar', 'missing', 'missing')).toThrow('Invalid bundle package name')
})

it('selects a profile update for an installation-owned external updater', () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-update-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const installation = join(root, 'app')
  const profile = join(root, 'profile')
  for (const dir of [installation, profile]) {
    const version = dir === installation ? '1.0.0' : '2.0.0'
    const bundle = join(dir, 'node_modules', 'custom-sidebar')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'custom-sidebar': version } }))
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'custom-sidebar', version,
      dsh: { bundle: { patch: './cordis.patch.yml', ...(dir === installation ? { updateManager: 'sidebar-updater' } : {}) } } }))
  }
  expect(resolveBundleDir('test', 'custom-sidebar', join(installation, 'package.json'), profile))
    .toBe(join(profile, 'node_modules', 'custom-sidebar'))
})
