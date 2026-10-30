/**
 * The AutoFlow npm bundle's declared entries, client module identity and lazy
 * chunks must match its built artifacts. Run `pnpm run build:sidebar` before
 * this spec; missing artifacts fail their owning assertions.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CHUNK_NAMES } from '../src/bundle-route.ts'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The npm metadata whose paths and module identity this spec checks. */
interface PackageJson {
  name: string
  private: boolean
  main: string
  types: string
  exports: { './client': { default: string; types: string } }
  files: string[]
  dsh: { bundle: { patch: string; updateManager: string }; client: { platform: string } }
}

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as PackageJson
const client = pkg.exports['./client']

/** Literal require() specifiers the frozen browser module table can answer. */
const CLIENT_REQUIRE_ALLOWED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

/** The registered `__ModuleLoader__.load({ id })` value of a built client bundle. */
function bundleId(file: string): string {
  const source = readFileSync(resolve(ROOT, file), 'utf8')
  const match = /load\(\{\s*id:\s*"([^"]+)"/.exec(source)
  if (match === null) throw new Error(`${file} registers no __ModuleLoader__.load id — run \`pnpm build\` first`)
  return match[1]!
}

/**
 * The lazy chunk bundles, DERIVED from the host route's registry (never
 * hand-mirrored: the hand-written list drifted once — `locale` was missing
 * from both this list and a later `package.json#files` cleanup, so a
 * published tarball could not serve it).
 */
const CHUNK_FILES = CHUNK_NAMES.map(name => `lib/client-${name}.js`)

/** Whether one `package.json#files` entry covers a built artifact path. */
function publishListCovers(entry: string, file: string): boolean {
  const included = entry.replace(/^\.\//, '').replace(/\/+$/, '')
  const artifact = file.replace(/^\.\//, '')
  // npm 的 files 目录条目递归包含其子文件，但不能匹配同名前缀的其他目录。
  if (included === artifact || artifact.startsWith(`${included}/`)) return true
  if (!included.includes('*')) return false
  // Only the `lib/client-*.js` shape is in play; a regex built from the entry
  // is enough (escape everything else).
  const pattern = new RegExp(`^${included.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
  return pattern.test(artifact)
}

/** The global registry slot a built chunk script assigns (its factory key). */
function chunkSlot(file: string): string {
  const source = readFileSync(resolve(ROOT, file), 'utf8')
  const match = /globalThis\.__dshChunks__\["([a-z0-9-]+)"\]/.exec(source)
  if (match === null) throw new Error(`${file} assigns no globalThis.__dshChunks__ slot — run \`pnpm build\` first`)
  return match[1]!
}

describe('npm bundle manifest consistency', () => {
  it('declares the private workspace bundle and its companion update manager', () => {
    expect(pkg.name).toBe('dsh-better-sidebar')
    expect(pkg.private).toBe(true)
    expect(pkg.dsh.bundle.updateManager).toBe('dsh-plugin-better-sidebar-updater')
    expect(pkg.dsh.client.platform).toBe('web')
  })

  it('declared runtime, type and bundle patch files exist', () => {
    for (const file of [pkg.main, pkg.types, client.default, client.types, pkg.dsh.bundle.patch]) {
      expect(existsSync(resolve(ROOT, file)), `${file} is missing; run pnpm run build:sidebar`).toBe(true)
    }
  })

  it('the exported client bundle registers the npm package name', () => {
    expect(bundleId(client.default)).toBe(pkg.name)
  })

  it('the lazy chunk bundles exist and assign their global registry slots (served by /sidebar/bundle)', () => {
    for (const file of CHUNK_FILES) {
      expect(existsSync(resolve(ROOT, file)), file).toBe(true)
      expect(chunkSlot(file), file).toBe(file.slice('lib/client-'.length, -'.js'.length))
    }
  })

  it('package.json#files covers every declared entry and lazy chunk', () => {
    for (const file of [pkg.main, pkg.types, client.default, client.types, pkg.dsh.bundle.patch, ...CHUNK_FILES]) {
      expect(
        pkg.files.some(entry => publishListCovers(entry, file)),
        `${file} is not covered by package.json#files (${pkg.files.join(', ')})`,
      ).toBe(true)
    }
    expect(publishListCovers('lib', 'library/client.js')).toBe(false)
  })

  it('client bundles require only frozen module-table entries', () => {
    for (const file of [client.default, ...CHUNK_FILES]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      // Exclude method calls such as `freeModule.require("util")`; only the
      // loader factory's lexical require() is constrained by the module table.
      const required = [...source.matchAll(/(^|[^.$\w])require\("([^"]+)"\)/gm)].map(match => match[2]!)
      expect([...new Set(required)].filter(id => !CLIENT_REQUIRE_ALLOWED.has(id)), file).toEqual([])
    }
  })
})
