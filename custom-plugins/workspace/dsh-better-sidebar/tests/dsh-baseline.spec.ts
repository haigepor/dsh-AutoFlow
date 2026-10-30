/**
 * AutoFlow bundles resolve DSH dependencies from the current workspace and
 * build the main plugin before its companion. Installation does not build either
 * package or restore the retired invariant companion.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

interface WorkspaceManifest {
  name: string
  version: string
  exports?: Record<string, unknown>
  files?: string[]
  scripts?: Record<string, string>
  workspaces?: string[]
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dependencies?: Record<string, string>
}

function readManifest(file: string | URL): WorkspaceManifest {
  return JSON.parse(readFileSync(file, 'utf8')) as WorkspaceManifest
}

const host = readManifest(new URL('../../../../package.json', import.meta.url))
const packageUrls = [new URL('../package.json', import.meta.url), new URL('../updater/package.json', import.meta.url)]
const packages = packageUrls.map(readManifest)
const build = readFileSync(new URL('../tsdown.config.ts', import.meta.url), 'utf8')

describe('AutoFlow workspace host baseline', () => {
  it('resolves declared DSH dependencies to the current host workspace version', () => {
    for (const [index, pkg] of packages.entries()) {
      const require = createRequire(packageUrls[index]!)
      let dshDependencies = 0
      for (const section of ['peerDependencies', 'devDependencies', 'dependencies'] as const) {
        for (const [name, version] of Object.entries(pkg[section] ?? {})) {
          if (!name.startsWith('@deepseek-ai/')) continue
          const isDsh = name.startsWith('@deepseek-ai/dsh-')
          expect(version, `${pkg.name} ${section}.${name}`).toBe(isDsh ? 'workspace:*' : 'workspace:~')
          if (!isDsh) continue
          dshDependencies++
          expect(readManifest(require.resolve(`${name}/package.json`)).version, `${pkg.name} ${name}`).toBe(host.version)
        }
      }
      expect(dshDependencies, pkg.name).toBeGreaterThan(0)
    }
  })

  it('does not publish or depend on the retired invariant companion', () => {
    for (const pkg of packages) {
      expect(pkg.exports).not.toHaveProperty('./invariant')
      expect(pkg.files).not.toContain('lib/invariant.js')
      for (const section of ['peerDependencies', 'devDependencies', 'dependencies'] as const) {
        expect(pkg[section] ?? {}).not.toHaveProperty('@deepseek-ai/dsh-invariants')
      }
    }
    expect(build).not.toContain('src/invariant.ts')
  })

  it('keeps installation free of plugin build lifecycle scripts', () => {
    for (const pkg of packages) {
      for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
        expect(pkg.scripts ?? {}, pkg.name).not.toHaveProperty(lifecycle)
      }
    }
  })

  it('declares both plugin workspaces and builds the companion after the main package', () => {
    expect(host.workspaces).toEqual(expect.arrayContaining([
      'custom-plugins/workspace/dsh-better-sidebar',
      'custom-plugins/workspace/dsh-better-sidebar/updater',
    ]))
    expect(host.scripts?.['build:sidebar']).toBe('pnpm --filter dsh-better-sidebar run build && pnpm --filter dsh-plugin-better-sidebar-updater run build')
    expect(packages[0]!.scripts?.build).toContain('node scripts/build-customizations.mjs')
    expect(packages[0]!.scripts?.build).toContain('tsc -p tsconfig.build.json')
    expect(packages[1]!.scripts?.build).toBe('node scripts/build-client.mjs')
  })
})
