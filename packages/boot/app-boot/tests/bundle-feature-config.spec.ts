/** JSON preferences preserve first-install migration and reject damaged files without rewriting them. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { DshBundleManifest } from '@deepseek-ai/dsh-package-manifest'
import { bundleFeatureConfigPath, parseBundleFeatureConfig, readBundleFeatureConfig, stageBundleFeatureConfigUpdate } from '../src/bundle-feature-config.ts'

const bundle: DshBundleManifest = { patch: 'patch.yml', featureConfig: './defaults.json', features: [
  { id: 'read', rowId: 'read', title: 'Read', description: 'Read', defaultEnabled: true },
  { id: 'write', rowId: 'write', title: 'Write', description: 'Write', defaultEnabled: false },
] }

it('resolves forward-slash profile paths before walking configuration parents', () => {
  const profile = join(tmpdir(), 'feature-owner')
  expect(bundleFeatureConfigPath(profile.replaceAll('\\', '/'), 'sample'))
    .toBe(join(profile, '.plugins', 'sample', 'config.json'))
})

it('keeps the running generation unchanged and merges fresh choices on successor startup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'feature-update-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const profile = join(root, 'profile'), oldPackage = join(root, 'old'), newPackage = join(root, 'new')
  for (const dir of [profile, oldPackage, newPackage]) mkdirSync(dir)
  const successor = { ...bundle, features: [...bundle.features!, { id: 'new', rowId: 'new', title: 'New', description: 'New', defaultEnabled: true }] }
  writeFileSync(join(oldPackage, 'package.json'), '{"version":"1.0.0"}')
  writeFileSync(join(newPackage, 'package.json'), '{"version":"1.1.0"}')
  writeFileSync(join(oldPackage, 'defaults.json'), JSON.stringify({ version: 1, features: { read: true, write: false } }))
  writeFileSync(join(newPackage, 'defaults.json'), JSON.stringify({ version: 1, features: { read: true, write: false, new: true } }))
  readBundleFeatureConfig(profile, oldPackage, 'sample', bundle)
  await stageBundleFeatureConfigUpdate(profile, 'sample', newPackage, '1.1.0', bundle, successor)
  expect(readBundleFeatureConfig(profile, oldPackage, 'sample', bundle).features).toEqual({ read: true, write: false })
  writeFileSync(bundleFeatureConfigPath(profile, 'sample'), JSON.stringify({ version: 1, features: { read: false, write: true } }))
  expect(readBundleFeatureConfig(profile, newPackage, 'sample', successor).features).toEqual({ read: false, write: true, new: true })
  expect(readBundleFeatureConfig(profile, newPackage, 'sample', successor).features).toEqual({ read: false, write: true, new: true })
})

it('creates from defaults, migrates explicit selections and preserves choices over changed package defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'feature-config-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const profile = join(root, 'profile'), pkg = join(root, 'package')
  mkdirSync(profile); mkdirSync(pkg)
  writeFileSync(join(pkg, 'defaults.json'), JSON.stringify({ version: 1, features: { read: true, write: false } }))
  writeFileSync(join(profile, 'cordis.patch.yml'), '[{"id":"write","disabled":false}]')
  expect(readBundleFeatureConfig(profile, pkg, 'sample', bundle).features).toEqual({ read: true, write: true })
  writeFileSync(join(pkg, 'defaults.json'), JSON.stringify({ version: 1, features: { read: false, write: false } }))
  expect(readBundleFeatureConfig(profile, pkg, 'sample', bundle).features).toEqual({ read: true, write: true })
  const config = bundleFeatureConfigPath(profile, 'sample')
  writeFileSync(config, '{damaged')
  expect(() => readBundleFeatureConfig(profile, pkg, 'sample', bundle)).toThrow()
  expect(readFileSync(config, 'utf8')).toBe('{damaged')
})

it('rejects unsupported versions, partial maps, unknown keys and escaping owners', () => {
  for (const input of [null, { version: 2, features: { read: true, write: false } }, { version: 1, features: { read: true } },
    { version: 1, features: { read: true, write: 'false' } }, { version: 1, features: { read: true, write: false, surprise: false } }]) {
    expect(() => parseBundleFeatureConfig(JSON.stringify(input), bundle)).toThrow()
  }
  expect(() => bundleFeatureConfigPath(join(tmpdir(), 'profile'), '../outside')).toThrow()
})
