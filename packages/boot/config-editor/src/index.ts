/** Profile-owned configuration edits, serialized with Loader hot reload. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, FiberState, Service, resolveConfig } from '@deepseek-ai/cordis'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-hmr'
import { bundlePatchPaths, composeEntries, loadOverlayPatches, loadProfileDirectory, readProfileManifest, readProfilePatches, reconcileProfilePatches, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isSeq, parseDocument, Scalar, visit } from 'yaml'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent edits to the active profile's plugin configuration. */
    configEditor: ConfigEditor
  }
}

function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])
}

/** Persist complete raw configs and apply them through the normal Loader path. */
export class ConfigEditor extends Service {
  static inject = ['loader', 'profileContext']

  constructor(private readonly ownerContext: Context) {
    super(ownerContext, 'configEditor')
  }

  /** The profile patch edited by this service. */
  get documentPath(): string { return this.ownerContext.profileContext.patchPath }

  /** 在调用方持有 profile 写锁时读取序列文档，缺失文件按空 patch 处理。 */
  private async readPatchDocument() {
    let before: string
    try { before = await readFile(this.documentPath, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      before = '[]\n'
    }
    const document = parseDocument(before, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    if (document.errors[0]) throw document.errors[0]
    if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
    const sequence = document.contents
    sequence.flow = false
    return { before, document, sequence }
  }

  /** Addressable profile rows; nested Includes have independent configuration ownership.
   * @returns Entries with unique profile patch ids, including disabled rows.
   */
  entries(): Entry[] {
    const candidates = [...this.ownerContext.loader.entries()].filter(entry => entry.parent.tree.ctx.fiber.entry?.id === 'include')
    const counts = new Map<string, number>()
    for (const entry of candidates) counts.set(entry.options.id, (counts.get(entry.options.id) ?? 0) + 1)
    return candidates.filter(entry => counts.get(entry.options.id) === 1)
  }

  /** Read inherited and explicit profile values for the active entries.
   * @returns Detached layer values alongside their Loader entries.
   */
  configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }> {
    const profile = this.ownerContext.profileContext
    const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
    const entries = this.entries()
    // An own config key can replace inherited config even when its value is undefined.
    const overridden = new Set(loaded.patches.filter(patch => patch.insert === undefined && Object.hasOwn(patch, 'config')).map(patch => patch.id))
    const composed = new Map<string, EntryOptions>()
    if (entries.some(entry => !overridden.has(entry.options.id))) {
      for (const row of flatten(composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches]))) {
        if (!composed.has(row.id)) composed.set(row.id, row)
      }
    }
    return entries.map(entry => ({
      entry,
      inherited: overridden.has(entry.options.id)
        ? this.inherited(entry, loaded)
        : structuredClone((composed.get(entry.options.id)?.config ?? {}) as Record<string, unknown>),
      override: structuredClone((loaded.patches.findLast(
        row => row.id === entry.options.id && row.config !== undefined,
      )?.config ?? {}) as Record<string, unknown>),
    }))
  }

  private inherited(entry: Entry, loaded: ReturnType<typeof loadProfileDirectory>): Record<string, unknown> {
    const patches = loaded.patches.map((patch) => {
      if (patch.id !== entry.options.id || patch.insert !== undefined) return patch
      const rest = { ...patch }; Reflect.deleteProperty(rest, 'config')
      return rest
    })
    const row = flatten(composeEntries([...loaded.layers.map(layer => layer.patches), patches])).find(row => row.id === entry.options.id)
    return structuredClone((row?.config ?? {}) as Record<string, unknown>)
  }

  /**
   * Persist a new, caller-validated plugin entry and reconcile its activation.
   * @param row - complete entry with a unique profile id and validated configuration.
   * @param validate - owner validation repeated while the profile write lock is held.
   * @returns fulfillment after persistence and Loader reconciliation; failures restore the prior patch.
   */
  async insert(row: EntryOptions, validate?: () => void): Promise<void> {
    const run = async (): Promise<void> => {
      const profile = this.ownerContext.profileContext
      await withFileLock(join(profile.dir, 'package.json'), async () => {
        const beforePatches = readProfilePatches('dsh', profile)
        validate?.()
        if (flatten(composeEntries([beforePatches])).some(entry => entry.id === row.id)) throw new Error('Configuration entry id is already in use')
        const { before, document } = await this.readPatchDocument()
        document.add(document.createNode({ insert: [row] }))
        const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
        const patches = readProfilePatches('dsh', profile, { ...loaded, patches: yaml.load(String(document), { schema: entryListSchema }) as PatchOptions[] })
        const effective = flatten(composeEntries([patches])).find(entry => entry.id === row.id)
        if (!effective || effective.name !== row.name || !isDeepStrictEqual(effective.config, row.config)
          || Boolean(effective.disabled) !== Boolean(row.disabled)) throw new Error('New configuration entry is overridden')
        await writeFileAtomic(this.documentPath, String(document), { mode: 0o600 })
        try {
          await reconcileProfilePatches(this.ownerContext.root, patches, 'dsh', row.disabled ? [] : [row.id])
        } catch (error) {
          await writeFileAtomic(this.documentPath, before, { mode: 0o600 })
          await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh')
          throw error
        }
      })
    }
    const hmr = this.ownerContext.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }

  /** Retain a deselected bundle's raw configs without mounting its plugins.
   * @param name Installed bundle whose defaults will be replaced.
   * @returns Fulfillment after dormant profile overrides are atomically saved.
   */
  async retainDisabledBundle(name: string): Promise<void> {
    const run = async (): Promise<void> => {
      const profile = this.ownerContext.profileContext
      await withFileLock(join(profile.dir, 'package.json'), async () => {
        if (readProfileManifest('dsh', profile.dir).dsh?.profile?.bundles?.includes(name)) throw new Error('Bundle is selected')
        const directory = resolveBundleDir('dsh', name, profile.installAnchor, profile.dir)
        const bundle = readProfileManifest('dsh', directory).dsh?.bundle
        if (!bundle) throw new Error('Bundle configuration is unavailable')
        const patchPaths = bundlePatchPaths(directory, bundle)
        const patches = patchPaths.flatMap(path => loadOverlayPatches('dsh', path))
        const owned = composeEntries([patches])
        if (!owned.length || owned.some(row => row.group)) throw new Error('Bundle configuration is not individually addressable')
        const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
        const active = flatten(composeEntries([readProfilePatches('dsh', profile, loaded)]))
        if (owned.some(row => active.some(entry => entry.id === row.id))) throw new Error('Bundle configuration id is already in use')
        // 只做离线组合；保存时不选择 bundle，也不执行任何插件或配置表达式。
        const candidate = { ...loaded, layers: [...loaded.layers, { packageName: name, packageDir: directory, patchPaths, patches }] }
        const effective = composeEntries([readProfilePatches('dsh', profile, candidate)])
        const retained = owned.map((row) => {
          const value = effective.find(entry => entry.id === row.id)
          if (!value || value.name !== row.name) throw new Error('Bundle configuration owner changed')
          const config: unknown = value.config
          return { id: row.id, name: row.name, config: config ?? {} }
        })
        const { document, sequence } = await this.readPatchDocument()
        for (const row of retained) {
          const index = sequence.items.findLastIndex((item, index) => isMap(item)
            && document.getIn([index, 'id']) === row.id && !item.has('insert')
            && (!item.has('name') || document.getIn([index, 'name']) === row.name))
          if (index < 0) document.add(document.createNode(row))
          else document.setIn([index, 'config'], document.createNode(row.config))
        }
        visit(document, { Map(_key, node) {
          if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return
          const expression = new Scalar(node.get('__jsExpr')); expression.tag = 'tag:yaml.org,2002:js'; return expression
        } })
        const saved = readProfilePatches('dsh', profile, { ...candidate, patches: yaml.load(String(document), { schema: entryListSchema }) as PatchOptions[] })
        const verified = composeEntries([saved])
        if (retained.some(row => !isDeepStrictEqual(verified.find(entry => entry.id === row.id)?.config, row.config))) throw new Error('Retained bundle configuration is overridden')
        await writeFileAtomic(this.documentPath, String(document), { mode: 0o600 })
      })
    }
    const hmr = this.ownerContext.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }

  /** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules.
   * @param entry Current Loader entry, also used to detect replacement during the write.
   * @param change Derive a raw config from the current entry and its inherited layer.
   * @param options.retainOverride Retain explicit config for package replacement.
   * @param options.validate Validate a complete raw config when its owning plugin is inactive.
   * @returns Fulfillment after Loader reconciliation completes.
   */
  async edit(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
    options: { retainOverride?: boolean; validate?: (raw: Record<string, unknown>) => void } = {},
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const path = this.documentPath
      await withFileLock(join(this.ownerContext.profileContext.dir, 'package.json'), async () => {
        if (!this.entries().includes(entry)) throw new Error('Configuration entry is no longer available')
        const beforePatches = readProfilePatches('dsh', this.ownerContext.profileContext)
        await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh')
        if (!this.entries().includes(entry)) throw new Error('Configuration entry changed during reload')
        const current = structuredClone((entry.options.config ?? {}) as Record<string, unknown>)
        const inherited = this.inherited(entry, loadProfileDirectory('dsh', this.ownerContext.profileContext.dir, this.ownerContext.profileContext.installAnchor))
        const next = change(structuredClone(current), inherited)
        const fiber = entry.fiber
        if (fiber?.state === FiberState.ACTIVE) {
          const resolved: unknown = fiber.ctx.waterfall(fiber, 'internal/config', next, () => next)
          resolveConfig(fiber.runtime as NonNullable<typeof fiber.runtime>, resolved)
        } else if (options.validate !== undefined) {
          options.validate(next)
        } else if (!options.retainOverride || !isDeepStrictEqual(next, current)) {
          // 停用时只允许原样固化配置；没有运行时 schema 时不能接受新的配置值。
          throw new Error('Configuration plugin is no longer active')
        }
        let before: string
        try { before = await readFile(path, 'utf8') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          before = '[]\n'
        }
        const document = parseDocument(before, {
          customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
        })
        if (document.errors[0] !== undefined) throw document.errors[0]
        if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
        document.contents.flow = false
        const index = document.contents.items.findLastIndex((item, index) => isMap(item)
          && document.getIn([index, 'id']) === entry.options.id && !item.has('insert')
          && (!item.has('name') || document.getIn([index, 'name']) === entry.options.name))
        if (!options.retainOverride && isDeepStrictEqual(next, inherited)) {
          for (let index = document.contents.items.length - 1; index >= 0; index--) {
            const row = document.contents.items[index]
            if (!isMap(row) || document.getIn([index, 'id']) !== entry.options.id || row.has('insert')) continue
            row.delete('config')
            if (row.items.length === Number(row.has('id')) + Number(row.has('name'))) document.delete(index)
          }
        } else if (index < 0) document.add(document.createNode({ id: entry.options.id, name: entry.options.name, config: next }))
        else document.setIn([index, 'config'], document.createNode(next))
        visit(document, { Map(_key, node) {
          if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return
          const expression = new Scalar(node.get('__jsExpr'))
          expression.tag = 'tag:yaml.org,2002:js'
          return expression
        } })
        const profile = this.ownerContext.profileContext
        const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
        const patches = readProfilePatches('dsh', profile, { ...loaded, patches: yaml.load(String(document), { schema: entryListSchema }) as PatchOptions[] })
        const effective = flatten(composeEntries([patches])).find(row => row.id === entry.options.id)
        if (!isDeepStrictEqual(effective?.config ?? {}, next)) {
          throw new Error(`Configuration for "${entry.options.id}" is overridden by a home patch or command-line overlay`)
        }
        await writeFileAtomic(path, String(document), { mode: 0o600 })
        try {
          await reconcileProfilePatches(this.ownerContext.root, patches, 'dsh', [entry.options.id])
        } catch (error) {
          await writeFileAtomic(path, before, { mode: 0o600 })
          await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh')
          throw error
        }
      })
    }
    const hmr = this.ownerContext.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }
}

export default ConfigEditor
