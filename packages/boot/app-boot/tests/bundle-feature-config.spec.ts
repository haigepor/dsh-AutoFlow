/** JSON preferences preserve first-install migration and reject damaged files without rewriting them. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { DshBundleManifest } from '@deepseek-ai/dsh-package-manifest'
import { bundleFeatureConfigPath, parseBundleFeatureConfig, readBundleFeatureConfig } from '../src/bundle-feature-config.ts'

const bundle: DshBundleManifest = { patch: 'patch.yml', featureConfig: './defaults.json', features: [
  { id: 'read', rowId: 'read', title: 'Read', description: 'Read', defaultEnabled: true },
  { id: 'write', rowId: 'write', title: 'Write', description: 'Write', defaultEnabled: false },
] }

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
