/** Profile-owned feature selections for bundles opting into JSON configuration. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
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
  const owner = resolve(profileDir)
  const path = join(owner, '.plugins', name, 'config.json')
  let parent = path
  while (parent !== owner) {
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
  applyPendingFeatureConfig(runtime, packageDir, bundle)
  if (existsSync(runtime)) return parseBundleFeatureConfig(readFileSync(runtime, 'utf8'), bundle)
  const config = featureTemplate(packageDir, bundle)
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

function featureTemplate(packageDir: string, bundle: DshBundleManifest): BundleFeatureConfig {
  const template = bundle.featureConfig
  if (typeof template !== 'string' || template === '' || isAbsolute(template)) throw new Error('Invalid bundle featureConfig path')
  const source = realpathSync(resolve(packageDir, template))
  const inside = relative(realpathSync(packageDir), source)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Bundle featureConfig escapes its package')
  return parseBundleFeatureConfig(readFileSync(source, 'utf8'), bundle)
}

/** Stage new feature defaults for the first read by the new package, retaining the running generation's file.
 * @param profileDir Configuration owner.
 * @param name Updated package name.
 * @param packageDir Validated installed successor.
 * @param version Exact successor version.
 * @param before Previous bundle declaration.
 * @param after Successor declaration.
 */
export async function stageBundleFeatureConfigUpdate(
  profileDir: string, name: string, packageDir: string, version: string, before: DshBundleManifest, after: DshBundleManifest,
): Promise<void> {
  const runtime = bundleFeatureConfigPath(profileDir, name)
  if (!existsSync(runtime)) return
  if (existsSync(`${runtime}.update.json`) && lstatSync(`${runtime}.update.json`).isSymbolicLink()) {
    throw new Error('Refusing linked feature update configuration')
  }
  parseBundleFeatureConfig(readFileSync(runtime, 'utf8'), before)
  if (after.featureConfig === undefined) throw new Error('An update cannot remove an existing feature configuration')
  const config = featureTemplate(packageDir, after)
  await writeFileAtomic(`${runtime}.update.json`, JSON.stringify({ version: 1, packageVersion: version,
    previousFeatures: (before.features ?? []).map(feature => feature.id), config }) + '\n', { mode: 0o600 })
}

function applyPendingFeatureConfig(runtime: string, packageDir: string, bundle: DshBundleManifest): void {
  const pending = `${runtime}.update.json`
  if (!existsSync(pending)) return
  if (lstatSync(pending).isSymbolicLink()) throw new Error('Refusing linked feature update configuration')
  const value: unknown = JSON.parse(readFileSync(pending, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid pending feature configuration')
  const record = value as { version?: unknown; packageVersion?: unknown; previousFeatures?: unknown; config?: unknown }
  if (record.version !== 1 || typeof record.packageVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(record.packageVersion)
    || !Array.isArray(record.previousFeatures) || !record.previousFeatures.every(id => typeof id === 'string')
    || new Set(record.previousFeatures).size !== record.previousFeatures.length) {
    throw new Error('Invalid pending feature configuration')
  }
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: unknown }
  if (manifest.version !== record.packageVersion) return
  const config = parseBundleFeatureConfig(JSON.stringify(record.config), bundle)
  const previous = JSON.parse(readFileSync(runtime, 'utf8')) as { version?: unknown; features?: unknown }
  if (previous.version !== 1 || typeof previous.features !== 'object' || previous.features === null || Array.isArray(previous.features)) {
    throw new Error('Invalid previous feature configuration')
  }
  const choices = previous.features as Record<string, unknown>
  const alreadyMigrated = Object.keys(choices).length === Object.keys(config.features).length
    && Object.keys(config.features).every(id => typeof choices[id] === 'boolean')
  if (Object.keys(choices).length !== record.previousFeatures.length
    || record.previousFeatures.some(id => typeof choices[id] !== 'boolean')) {
    // 原子替换成功但清理中断时，保留已写入的选择并完成清理。
    if (alreadyMigrated) { unlinkSync(pending); return }
    throw new Error('Invalid previous feature selections')
  }
  for (const id of Object.keys(config.features)) if (typeof choices[id] === 'boolean') config.features[id] = choices[id]
  const temporary = `${runtime}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  // 仅新版首次读取时原子替换；正在运行的旧插件继续使用原文件。
  try { renameSync(temporary, runtime) }
  finally { if (existsSync(temporary)) unlinkSync(temporary) }
  unlinkSync(pending)
}

/** Project desired booleans into Cordis overlays applied after legacy profile patches.
 * @param bundle Bundle metadata.
 * @param config Validated current selections.
 * @returns Row enablement overlays without changing deployment config.
 */
export function bundleFeaturePatches(bundle: DshBundleManifest, config: BundleFeatureConfig): PatchOptions[] {
  return (bundle.features ?? []).map(feature => ({ id: feature.rowId, disabled: !config.features[feature.id] }))
}
