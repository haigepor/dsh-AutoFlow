/** Profile-owned feature selections for bundles opting into JSON configuration. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { DshBundleManifest } from '@deepseek-ai/dsh-package-manifest'
import { loadOptionalPatches } from './index.ts'

/** Versioned, complete desired selections; credentials and deployment settings live elsewhere. */
export interface BundleFeatureConfig {
  /** File generation supported by this reader. */
  version: 1
  /** Exactly one boolean per declared feature id. */
  features: Record<string, boolean>
}

/** Resolve a contained runtime filename, refusing symlinked configuration paths.
 * @param profileDir Absolute profile directory.
 * @param name Installed package name.
 * @returns Profile-owned JSON filename.
 */
export function bundleFeatureConfigPath(profileDir: string, name: string): string {
  if (!isAbsolute(profileDir) || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('Invalid feature configuration owner')
  const path = join(profileDir, '.plugins', name, 'config.json')
  let parent = path
  while (parent !== profileDir) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error(`Refusing linked feature configuration: ${parent}`)
    parent = dirname(parent)
  }
  return path
}

/** Validate file JSON, including complete keys and boolean values.
 * @param text UTF-8 JSON text.
 * @param bundle Declared features and defaults path.
 * @returns Validated desired selections.
 */
export function parseBundleFeatureConfig(text: string, bundle: DshBundleManifest): BundleFeatureConfig {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid bundle feature config')
  const input = value as { version?: unknown; features?: unknown }
  if (input.version !== 1 || Object.keys(input).some(key => key !== 'version' && key !== 'features')
    || typeof input.features !== 'object' || input.features === null || Array.isArray(input.features)) throw new Error('Invalid bundle feature config version or fields')
  const values = input.features as Record<string, unknown>
  const declared = bundle.features ?? []
  if (declared.length === 0 || new Set(declared.map(feature => feature.id)).size !== declared.length
    || Object.keys(values).length !== declared.length
    || declared.some(feature => !Object.hasOwn(values, feature.id) || typeof values[feature.id] !== 'boolean')) {
    throw new Error('Feature config must contain exactly the declared boolean feature ids')
  }
  const features: Record<string, boolean> = {}
  for (const feature of declared) features[feature.id] = values[feature.id] as boolean
  return { version: 1, features }
}

/** Read or initialize desired selections. Explicit legacy patch choices migrate only on creation.
 * @param profileDir Absolute profile directory.
 * @param packageDir Resolved installed package directory.
 * @param name Package name.
 * @param bundle Bundle declaration with featureConfig.
 * @returns Validated profile config; invalid existing files are never rewritten.
 */
export function readBundleFeatureConfig(
  profileDir: string, packageDir: string, name: string, bundle: DshBundleManifest,
): BundleFeatureConfig {
  const runtime = bundleFeatureConfigPath(profileDir, name)
  if (existsSync(runtime)) return parseBundleFeatureConfig(readFileSync(runtime, 'utf8'), bundle)
  const template = bundle.featureConfig
  if (typeof template !== 'string' || template === '' || isAbsolute(template)) throw new Error('Invalid bundle featureConfig path')
  const source = realpathSync(resolve(packageDir, template))
  const inside = relative(realpathSync(packageDir), source)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Bundle featureConfig escapes its package')
  const config = parseBundleFeatureConfig(readFileSync(source, 'utf8'), bundle)
  const legacy = loadOptionalPatches('dsh', join(profileDir, 'cordis.patch.yml')) ?? []
  for (const feature of bundle.features ?? []) {
    const explicit = legacy.filter(patch => patch.id === feature.rowId && typeof patch.disabled === 'boolean').at(-1)
    if (explicit !== undefined) config.features[feature.id] = explicit.disabled !== true
  }
  mkdirSync(dirname(runtime), { recursive: true, mode: 0o700 })
  // Exclusive creation preserves a concurrent install's choices; a partial file fails loud on its next read.
  try { writeFileSync(runtime, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  return parseBundleFeatureConfig(readFileSync(runtime, 'utf8'), bundle)
}

/** Project desired booleans into Cordis overlays applied after legacy profile patches.
 * @param bundle Bundle metadata.
 * @param config Validated current selections.
 * @returns Row enablement overlays without changing deployment config.
 */
export function bundleFeaturePatches(bundle: DshBundleManifest, config: BundleFeatureConfig): PatchOptions[] {
  return (bundle.features ?? []).map(feature => ({ id: feature.rowId, disabled: !config.features[feature.id] }))
}
