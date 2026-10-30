/** Profile-owned skill management with native directory and invocation-policy integration. */
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { FileSystemSkillProvider, parseSkillDocument } from '@deepseek-ai/dsh-skill-filesystem'
import type { SkillDirectory } from '@deepseek-ai/dsh-skill'
import {
  assertUnlinked,
  containedPath,
  digest,
  directoryId,
  directoryTree,
  fileIndex,
  ManagementError,
  readTree,
  skillId,
  SkillFiles,
  statOptional,
} from './files.ts'
import { decodeArchive, repositoryArchive } from './repositories.ts'
import { marketplaceFiles, marketplaceSearch } from './marketplaces.ts'
import type {
  ManagedDirectory,
  ManagedSkill,
  ManagedSkillDetail,
  ManagedSkillId,
  MarketplaceSkill,
  RepositorySkill,
  SkillBackup,
  SkillBackupId,
  SkillDirectoryId,
  SkillImportFile,
  SkillOperationResult,
  SkillManagementSnapshot,
  SkillUpdatePreview,
} from './types.ts'

/** Deployment limits for local imports and public downloads. */
export interface Config {
  /** Maximum compressed and expanded bytes admitted for one skill bundle. */
  maxBytes?: number
  /** Maximum file members admitted for one skill bundle. */
  maxFiles?: number
  /** Deadline in milliseconds for one public repository or marketplace request. */
  requestTimeoutMs?: number
}
/** Validated archive and network limits. */
export const Config: z<Config> = z.object({
  maxBytes: z
    .number()
    .min(1)
    .default(32 * 1024 * 1024),
  maxFiles: z.number().min(1).default(1000),
  requestTimeoutMs: z.number().min(1).default(30000),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillManagement: SkillManagement
  }
}

/** Trusted local management; skill execution remains owned by the existing consumers. */
export default class SkillManagement extends TypertRemoteService {
  static inject = ['skills', 'profileContext', 'workspaceRegistry']
  static Config = Config
  private readonly files: SkillFiles
  private readonly timeoutMs: number
  private readonly policy: ReturnType<Context['skills']['registerManagementPolicy']>
  private externalDispose: (() => void) | undefined
  private readonly pendingPreviews = new Map<
    string,
    {
      workspace: string
      directory: ManagedDirectory
      row: ManagedSkill
      files: Record<string, Uint8Array>
      preview: SkillUpdatePreview
    }
  >()

  /**
   * @param ctx - profile and native skill services.
   * @param config - archive and request limits.
   */
  constructor(
    private readonly owner: Context,
    config: Config = {},
  ) {
    super(owner, 'skillManagement')
    this.files = new SkillFiles(
      join(owner.profileContext.dir, 'skills-manager'),
      config.maxBytes ?? 32 * 1024 * 1024,
      config.maxFiles ?? 1000,
    )
    this.timeoutMs = config.requestTimeoutMs ?? 30000
    owner.effect(
      () =>
        owner.skills.registerProvider(
          control =>
            new FileSystemSkillProvider(owner, control, {
              providerName: 'skill-creator-bundled',
              includeDefaultRoots: false,
              bundledSkillDir: fileURLToPath(new URL('../assets/', import.meta.url)),
              watch: false,
            }),
        ),
      'skill-management: bundled creator',
    )
    for (const value of [this.files.maxBytes, this.files.maxFiles, this.timeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new ManagementError('invalid')
    }
    // 管理策略只减少原始调用权限；同名的下一份可用副本仍由原生注册表裁决。
    this.policy = owner.skills.registerManagementPolicy((candidate) => {
      const path = candidate.path
      const identity = path ?? `${candidate.provider}:${candidate.name}`
      const base = candidate.resourceBase?.kind === 'directory' ? candidate.resourceBase.path : undefined
      const root =
        base !== undefined
          ? path !== undefined && basename(path) === 'SKILL.md'
            ? dirname(base)
            : base
          : path === undefined
            ? candidate.provider
            : dirname(basename(path) === 'SKILL.md' ? dirname(path) : path)
      return this.files.state.disabled.includes(skillId(identity)) ||
        this.files.state.disabled.includes(directoryId(root))
        ? false
        : undefined
    })
    owner.effect(
      () => async () => {
        this.externalDispose?.()
        await this.policy.dispose()
        this.pendingPreviews.clear()
      },
      'skill-management: registrations',
    )
    owner.effect(async () => {
      await this.files.ready
      this.refreshExternalProvider()
      return () => {
        this.externalDispose?.()
        this.externalDispose = undefined
      }
    }, 'skill-management: external sources')
  }

  private workspace(path: string): string | undefined {
    if (!path) return undefined
    const workspace = this.owner.workspaceRegistry.list().find(item => resolve(item.path) === resolve(path))
    if (workspace === undefined) throw new ManagementError('unsafe-path')
    return workspace.path
  }
  private refreshExternalProvider(): void {
    this.externalDispose?.()
    this.externalDispose = this.owner.skills.registerProvider((control) => {
      const provider = new FileSystemSkillProvider(this.owner, control, {
        providerName: 'skill-management-external',
        includeDefaultRoots: false,
        customSkillDirs: this.files.state.roots,
      })
      return {
        name: provider.name,
        directories: options => provider.directories(options),
        list: async (options) => {
          const value = await provider.list(options)
          const candidates = Array.isArray(value) ? value : value.candidates
          const ranked = candidates.map(candidate => ({ ...candidate, rank: 700 }))
          return Array.isArray(value) ? ranked : { candidates: ranked, complete: value.complete }
        },
        get: (candidate, options) => provider.get(candidate, options),
      }
    })
  }
  private changed(): void {
    this.pendingPreviews.clear()
    this.policy.invalidate()
    this.owner.emit('skill-management/changed')
  }
  private async operation(task: () => Promise<void>): Promise<SkillOperationResult> {
    try {
      await task()
      this.changed()
      return { status: 'saved' }
    } catch (error) {
      if (!(error instanceof ManagementError)) this.owner.logger.warn('skill management operation failed', error)
      return { status: 'rejected', code: error instanceof ManagementError ? error.code : 'storage' }
    }
  }

  /** List all concrete and runtime copies for a registered local workspace.
   *
 * @param workspace - registered workspace path, or empty for global sources.
   *
 * @returns inventory retaining invalid, restricted and shadowed skills.

 */
  @Remote
  async list(workspace: string): Promise<SkillManagementSnapshot> {
    await this.files.ready
    const cwd = this.workspace(workspace)
    const presets = this.owner.get('agentPresets')
    await using lease = await presets?.acquireScope()
    const scope = lease?.key
    const observed = await this.owner.skills.inspect({ cwd, scope })
    const roots = new Map<string, SkillDirectory>()
    for (const root of observed.directories) roots.set(resolve(root.path), root)
    const directories: ManagedDirectory[] = [...roots.values()].map(root => ({
      id: directoryId(root.path),
      path: root.path,
      source: root.source,
      writable: root.writable,
      enabled: !this.files.state.disabled.includes(directoryId(root.path)),
      external: this.files.state.roots.includes(root.path),
    }))
    const skills: ManagedSkill[] = []
    let complete = observed.complete
    for (const directory of directories) {
      try {
        skills.push(...(await this.files.scan(directory)))
      } catch (_inaccessibleSource) {
        complete = false
      }
    }
    const winners = await this.owner.skills.list({ cwd, scope })
    for (const candidate of observed.candidates) {
      if (candidate.path !== undefined && skills.some(row => row.path === candidate.path)) continue
      const identity = candidate.path ?? `${candidate.provider}:${candidate.name}`
      const id = skillId(identity)
      const rootPath =
        candidate.resourceBase?.kind === 'directory' ? dirname(candidate.resourceBase.path) : candidate.provider
      const rootId = directoryId(rootPath)
      if (!directories.some(root => root.id === rootId))
        directories.push({
          id: rootId,
          path: rootPath,
          source: candidate.source,
          writable: false,
          enabled: true,
          external: false,
        })
      skills.push({
        id,
        directoryId: rootId,
        name: candidate.name,
        description: candidate.description,
        path: candidate.path ?? '',
        revision: '',
        enabled: !this.files.state.disabled.includes(id),
        modelInvocable: candidate.invocation.modelInvocable,
        userInvocable: candidate.invocation.userInvocable,
        writable: false,
        valid: true,
        diagnostics: [],
        effective: false,
        category: '',
        order: 0,
      })
    }
    for (const row of skills)
      row.effective =
        row.enabled && winners.some(winner => winner.name === row.name && (winner.path ?? '') === row.path)
    return {
      directories,
      skills: skills.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
      workspaces: this.owner.workspaceRegistry.list().map(item => item.path),
      categories: this.files.state.categories,
      complete,
      limits: { maxBytes: this.files.maxBytes, maxFiles: this.files.maxFiles },
    }
  }
  private async locate(
    id: ManagedSkillId,
    workspace: string,
    writable = false,
  ): Promise<{ row: ManagedSkill; directory: ManagedDirectory }> {
    const snapshot = await this.list(workspace)
    const row = snapshot.skills.find(item => item.id === id)
    const directory = snapshot.directories.find(item => item.id === row?.directoryId)
    if (row === undefined || directory === undefined) throw new ManagementError('not-found')
    if (writable && (!row.writable || !directory.writable)) throw new ManagementError('read-only')
    return { row, directory }
  }
  private async destination(id: SkillDirectoryId, workspace: string): Promise<ManagedDirectory> {
    const root = (await this.list(workspace)).directories.find(item => item.id === id)
    if (root === undefined || !root.writable) throw new ManagementError('read-only')
    await assertUnlinked(root.path)
    return root
  }
  /** Read an exact copy without redirecting a shadowed row to its same-name winner.
   *
 * @param id - inventory copy identity.
 * @param workspace - selected workspace.
   *
 * @returns complete Markdown and current metadata.

 */
  @Remote
  async detail(id: ManagedSkillId, workspace: string): Promise<ManagedSkillDetail> {
    const { row } = await this.locate(id, workspace)
    await using lease = row.path ? undefined : await this.owner.get('agentPresets')?.acquireScope()
    const document = row.path
      ? await readFile(row.path, 'utf8')
      : ((await this.owner.skills.get(row.name, { cwd: this.workspace(workspace), scope: lease?.key }))?.content ?? '')
    const tree: ManagedSkillDetail['tree'] = !row.path
      ? { entries: [], complete: true }
      : basename(row.path) === 'SKILL.md'
        ? await directoryTree(dirname(row.path), this.files.maxFiles)
        : { entries: [{ path: basename(row.path), kind: 'file' }], complete: true }
    return { skill: row, document, tree }
  }
  /** Set a copy or source restriction without rewriting skill frontmatter.
   *
 * @param id - copy or source identity.
 * @param enabled - desired permission.
 * @param workspace - selected workspace.
   *
 * @returns committed outcome.

 */
  @Remote
  async setEnabled(id: string, enabled: boolean, workspace: string): Promise<SkillOperationResult> {
    return this.operation(() =>
      this.files.mutate(async () => {
        const snapshot = await this.list(workspace)
        if (![...snapshot.skills, ...snapshot.directories].some(item => item.id === id))
          throw new ManagementError('not-found')
        this.files.state.disabled = this.files.state.disabled.filter(item => item !== id)
        if (!enabled) this.files.state.disabled.push(id)
      }),
    )
  }
  /** Save an existing writable document using its opened revision.
   *
 * @param id - copy identity.
 * @param document - complete Markdown.
 * @param revision - opened digest.
 * @param workspace - selected workspace.
   *
 * @returns committed outcome.

 */
  @Remote
  async save(id: ManagedSkillId, document: string, revision: string, workspace: string): Promise<SkillOperationResult> {
    return this.operation(async () => {
      let rollback: (() => Promise<void>) | undefined
      try {
        await this.files.mutate(async () => {
          const { row } = await this.locate(id, workspace, true)
          if (row.revision !== revision) throw new ManagementError('conflict')
          if (Buffer.byteLength(document) > this.files.maxBytes) throw new ManagementError('too-large')
          try {
            parseSkillDocument(document)
          } catch (_invalidDocument) {
            throw new ManagementError('invalid')
          }
          await assertUnlinked(row.path)
          await this.files.backup(row, 'update')
          const previous = await readFile(row.path)
          if (digest(previous) !== revision) throw new ManagementError('conflict')
          const stage = `${row.path}.${randomUUID()}.stage`
          await writeFile(stage, document.replace(/\s*$/u, '\n'), { encoding: 'utf8', flag: 'wx' })
          await rename(stage, row.path)
          rollback = async () => {
            await writeFile(row.path, previous)
          }
        })
      } catch (error) {
        await rollback?.()
        throw error
      }
    })
  }
  /** Create or import a complete skill bundle into an explicit writable root.
   *
 * @param directoryId - selected destination.
 * @param files - browser-selected relative members.
   *
 * @param overwrite - explicit conflict acceptance.
 * @param workspace - selected workspace.
   *
 * @returns committed outcome.

 */
  @Remote
  async importFiles(
    directoryId: SkillDirectoryId,
    files: SkillImportFile[],
    overwrite: boolean,
    workspace: string,
  ): Promise<SkillOperationResult> {
    return this.operation(async () => {
      const root = await this.destination(directoryId, workspace)
      let bytes = 0
      if (files.length > this.files.maxFiles) throw new ManagementError('too-large')
      let members = Object.create(null) as Record<string, Uint8Array>
      for (const file of files) {
        if (file.base64.length > Math.ceil(this.files.maxBytes / 3) * 4) throw new ManagementError('too-large')
        const data = Buffer.from(file.base64, 'base64')
        bytes += data.length
        if (bytes > this.files.maxBytes) throw new ManagementError('too-large')
        containedPath(root.path, file.path)
        members[file.path] = data
        if (files.length === 1 && file.path.endsWith('.zip'))
          members = decodeArchive(data, this.files.maxBytes, this.files.maxFiles)
      }
      const documents = Object.keys(members).filter(
        path =>
          path === 'SKILL.md' ||
          path.endsWith('/SKILL.md') ||
          (Object.keys(members).length === 1 && path.endsWith('.md')),
      )
      const [document] = documents
      if (documents.length !== 1 || document === undefined) throw new ManagementError('invalid')
      const parsed = parseSkillDocument(new TextDecoder('utf-8', { fatal: true }).decode(members[document]))
      const prefix = document.includes('/') ? document.slice(0, document.lastIndexOf('/') + 1) : ''
      const bundle = Object.fromEntries(
        Object.entries(members)
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, value]) => [path === document ? 'SKILL.md' : path.slice(prefix.length), value]),
      )
      await this.commitBundle(root, parsed.name, bundle, overwrite, workspace)
    })
  }
  private async commitBundle(
    root: ManagedDirectory,
    name: string,
    members: Record<string, Uint8Array>,
    overwrite: boolean,
    workspace: string,
    installation?: { repository: string; path: string; commit: string; files: Record<string, string> },
  ): Promise<void> {
    const target = containedPath(root.path, name)
    let transaction: Awaited<ReturnType<SkillFiles['replace']>> | undefined
    try {
      await this.files.mutate(async () => {
        const previous = (await this.list(workspace)).skills.find(row => row.path === join(target, 'SKILL.md'))
        if (previous !== undefined && overwrite) await this.files.backup(previous, 'update')
        transaction = await this.files.replace(target, members, overwrite)
        const id = skillId(join(target, 'SKILL.md'))
        if (installation !== undefined) this.files.state.installations[id] = installation
        else
          this.files.state.installations = Object.fromEntries(
            Object.entries(this.files.state.installations).filter(([key]) => key !== id),
          )
      })
    } catch (error) {
      await transaction?.rollback()
      throw error
    }
    await transaction?.finish()
  }
  /** Move a writable skill to recoverable storage.
   *
 * @param id - copy identity.
 * @param workspace - selected workspace.
 * @returns committed outcome.

 */
  @Remote
  async trash(id: ManagedSkillId, workspace: string): Promise<SkillOperationResult> {
    return this.operation(async () => {
      let moved: { target: string; stage: string } | undefined
      try {
        await this.files.mutate(async () => {
          const { row } = await this.locate(id, workspace, true)
          await this.files.backup(row, 'trash')
          await assertUnlinked(row.path)
          const target = basename(row.path) === 'SKILL.md' ? dirname(row.path) : row.path
          const stage = containedPath(dirname(target), `.skill-trash-${randomUUID()}`)
          await rename(target, stage)
          moved = { target, stage }
          this.files.state.installations = Object.fromEntries(
            Object.entries(this.files.state.installations).filter(([key]) => key !== id),
          )
        })
      } catch (error) {
        if (moved !== undefined) await rename(moved.stage, moved.target)
        throw error
      }
      if (moved !== undefined) await rm(moved.stage, { recursive: true })
    })
  }
  /** Read recoverable deletions and replacements.
   * @returns retained backups.
   */
  @Remote
  async backups(): Promise<SkillBackup[]> {
    await this.files.ready
    return this.files.state.backups.map(record => ({ ...record, id: brandString<SkillBackupId>(record.id) }))
  }
  /** Restore a retained copy or permanently remove its private backup.
   *
 * @param id - backup identity.
 * @param remove - permanent removal.
 * @param workspace - selected workspace.
   *
 * @returns committed outcome; an occupied original destination is never overwritten.

 */
  @Remote
  async restore(id: SkillBackupId, remove: boolean, workspace: string): Promise<SkillOperationResult> {
    return this.operation(async () => {
      let transaction: Awaited<ReturnType<SkillFiles['replace']>> | undefined
      let cleanup: string | undefined
      let flat: { target: string; before: Uint8Array | undefined } | undefined
      try {
        await this.files.mutate(async () => {
          const record = this.files.state.backups.find(item => item.id === id)
          if (record === undefined) throw new ManagementError('not-found')
          const path = containedPath(this.files.root, `backups/${id}`)
          if (remove) cleanup = path
          else {
            const root = await this.destination(brandString<SkillDirectoryId>(record.directoryId), workspace)
            if (resolve(dirname(record.target)) !== resolve(root.path)) throw new ManagementError('unsafe-path')
            await assertUnlinked(record.target)
            if (record.kind === 'trash' && (await statOptional(record.target)) !== undefined)
              throw new ManagementError('conflict')
            await mkdir(dirname(record.target), { recursive: true })
            const members = await readTree(path, this.files.maxBytes, this.files.maxFiles)
            if (record.target.endsWith('.md')) {
              const before =
                (await statOptional(record.target)) === undefined ? undefined : await readFile(record.target)
              const [member] = Object.values(members)
              if (member === undefined) throw new ManagementError('not-found')
              await writeFile(record.target, member, { flag: record.kind === 'trash' ? 'wx' : 'w' })
              flat = { target: record.target, before }
            } else transaction = await this.files.replace(record.target, members, record.kind === 'update')
            if (record.installation !== undefined)
              this.files.state.installations[
                skillId(record.target.endsWith('.md') ? record.target : join(record.target, 'SKILL.md'))
              ] = record.installation
          }
          this.files.state.backups = this.files.state.backups.filter(item => item.id !== id)
        })
      } catch (error) {
        await transaction?.rollback()
        if (flat !== undefined) {
          if (flat.before === undefined) await rm(flat.target)
          else await writeFile(flat.target, flat.before)
        }
        throw error
      }
      await transaction?.finish()
      if (cleanup !== undefined) await rm(cleanup, { recursive: true })
    })
  }
  /** Register or forget an external read-only directory.
   *
 * @param path - existing local directory.
 * @param remove - remove its registration, retaining all files.
   *
 * @returns committed outcome.

 */
  @Remote
  async source(path: string, remove: boolean): Promise<SkillOperationResult> {
    return this.operation(async () => {
      await this.files.mutate(async () => {
        if (remove) {
          this.files.state.roots = this.files.state.roots.filter(item => item !== resolve(path))
          return
        }
        const root = await realpath(path)
        if (!(await statOptional(root))?.isDirectory() || this.files.state.roots.includes(root))
          throw new ManagementError('invalid')
        if ((await this.list('')).directories.some(item => resolve(item.path) === root))
          throw new ManagementError('conflict')
        this.files.state.roots.push(root)
      })
      this.refreshExternalProvider()
    })
  }
  /** Assign a display-only category and ordering to an exact copy.
   *
 * @param id - copy identity.
 * @param category - display category, empty clears it.
 * @param order - display order.
 * @param workspace - selected workspace.
   *
 * @returns committed outcome.

 */
  @Remote
  async arrange(id: ManagedSkillId, category: string, order: number, workspace: string): Promise<SkillOperationResult> {
    return this.operation(() =>
      this.files.mutate(async () => {
        await this.locate(id, workspace)
        if (category.length > 100 || !Number.isFinite(order)) throw new ManagementError('invalid')
        this.files.state.arrangement[id] = { category: category.trim(), order }
        if (category && !this.files.state.categories.includes(category.trim()))
          this.files.state.categories.push(category.trim())
      }),
    )
  }
  /** Inspect a public repository without installing or executing its files.
   *
 * @param repository - GitHub URL or owner/repository.
 * @param ref - branch, tag or commit.
   *
 * @returns immutable install candidates.

 */
  @Remote
  async discover(repository: string, ref: string): Promise<RepositorySkill[]> {
    return (await repositoryArchive(repository, ref, this.files.maxBytes, this.files.maxFiles, this.timeoutMs)).skills
  }
  /** Read registered public repository subscriptions.
   * @returns stored repository/ref pairs.
   */
  @Remote
  async repositories(): Promise<{ repository: string; ref: string }[]> {
    await this.files.ready
    return this.files.state.repositories
  }
  /** Save or remove a repository subscription without installing files.
   *
 * @param repository - owner/repository.
 * @param ref - branch or commit.
 * @param remove - remove registration.
   *
 * @returns committed outcome.

 */
  @Remote
  async subscribe(repository: string, ref: string, remove: boolean): Promise<SkillOperationResult> {
    return this.operation(() =>
      this.files.mutate(() => {
        const name = repository
          .trim()
          .replace(/^https:\/\/github\.com\//u, '')
          .replace(/\/$/u, '')
        if (!/^[\w.-]+\/[\w.-]+$/u.test(name) || !ref || ref.length > 200) throw new ManagementError('invalid')
        this.files.state.repositories = this.files.state.repositories.filter(item => item.repository !== name)
        if (!remove) this.files.state.repositories.push({ repository: name, ref })
      }),
    )
  }
  /** Query a fixed public catalog.
   * @param catalog - marketplace.
   * @param query - search text.
   * @returns validated candidates.
   */
  @Remote
  async marketplace(catalog: MarketplaceSkill['catalog'], query: string): Promise<MarketplaceSkill[]> {
    return marketplaceSearch(catalog, query, this.timeoutMs)
  }
  /** Import an explicitly selected public marketplace skill.
   *
 * @param skill - marketplace identity.
 * @param directory - writable destination.
 * @param overwrite - accepted conflict.
 * @param workspace - registered workspace.
   *
 * @returns committed outcome.

 */
  @Remote
  async installMarketplace(
    skill: MarketplaceSkill,
    directory: SkillDirectoryId,
    overwrite: boolean,
    workspace: string,
  ): Promise<SkillOperationResult> {
    try {
      return await this.importFiles(
        directory,
        await marketplaceFiles(skill, this.files.maxBytes, this.files.maxFiles, this.timeoutMs),
        overwrite,
        workspace,
      )
    } catch (error) {
      return { status: 'rejected', code: error instanceof ManagementError ? error.code : 'network' }
    }
  }
  /** Apply a category-wide restriction without modifying any source file.
   *
 * @param category - category name.
 * @param enabled - desired permission.
 * @param workspace - selected workspace.
   *
 * @returns committed outcome.

 */
  @Remote
  async setCategoryEnabled(category: string, enabled: boolean, workspace: string): Promise<SkillOperationResult> {
    return this.operation(() =>
      this.files.mutate(async () => {
        const rows = (await this.list(workspace)).skills.filter(row => row.category === category)
        const ids = new Set(rows.map(row => row.id))
        this.files.state.disabled = this.files.state.disabled.filter(id => !ids.has(brandString<ManagedSkillId>(id)))
        if (!enabled) this.files.state.disabled.push(...ids)
      }),
    )
  }
  /** Install an explicitly selected immutable repository candidate.
   *
 * @param candidate - discovered identity.
 * @param directoryId - destination.
 * @param overwrite - accepted conflict.
 * @param workspace - selected workspace.
   *
 * @returns committed outcome.

 */
  @Remote
  async installSkill(
    candidate: RepositorySkill,
    directoryId: SkillDirectoryId,
    overwrite: boolean,
    workspace: string,
  ): Promise<SkillOperationResult> {
    return this.operation(async () => {
      const root = await this.destination(directoryId, workspace)
      const archive = await repositoryArchive(
        candidate.repository,
        candidate.commit,
        this.files.maxBytes,
        this.files.maxFiles,
        this.timeoutMs,
      )
      const selected = archive.skills.find(item => item.path === candidate.path && item.name === candidate.name)
      if (selected === undefined) throw new ManagementError('conflict')
      const prefix = selected.path ? `${selected.path}/` : ''
      const members = Object.fromEntries(
        Object.entries(archive.files)
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, bytes]) => [path.slice(prefix.length), bytes]),
      )
      await this.commitBundle(root, selected.name, members, overwrite, workspace, {
        ...selected,
        files: fileIndex(members),
      })
    })
  }
  /** Preview current upstream changes while preserving local modifications.
   *
 * @param id - installed copy.
 * @param ref - upstream branch/tag/commit.
 * @param workspace - selected workspace.
   *
 * @returns a bounded preview token required for replacement.

 */
  @Remote
  async preview(id: ManagedSkillId, ref: string, workspace: string): Promise<SkillUpdatePreview> {
    const { row, directory } = await this.locate(id, workspace, true)
    const installed = this.files.state.installations[id]
    if (installed === undefined) throw new ManagementError('invalid')
    const archive = await repositoryArchive(
      installed.repository,
      ref,
      this.files.maxBytes,
      this.files.maxFiles,
      this.timeoutMs,
    )
    const prefix = installed.path ? `${installed.path}/` : ''
    const files = Object.fromEntries(
      Object.entries(archive.files)
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, bytes]) => [path.slice(prefix.length), bytes]),
    )
    if (parseSkillDocument(new TextDecoder().decode(files['SKILL.md'])).name !== row.name)
      throw new ManagementError('conflict')
    const before = fileIndex(await readTree(dirname(row.path), this.files.maxBytes, this.files.maxFiles))
    const after = fileIndex(files)
    const token = digest(JSON.stringify({ id, before, after, commit: archive.commit }))
    const preview: SkillUpdatePreview = {
      id,
      token,
      commit: archive.commit,
      localModified: JSON.stringify(before) !== JSON.stringify(installed.files),
      changes: [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .sort()
        .filter(path => before[path] !== after[path])
        .map(path => ({
          path,
          kind: before[path] === undefined ? 'added' : after[path] === undefined ? 'removed' : 'modified',
        })),
    }
    // 只保留一个当前预览，避免过期下载与新操作混用，也限制暂存内存。
    this.pendingPreviews.clear()
    this.pendingPreviews.set(token, { workspace, directory, row, files, preview })
    return preview
  }
  /** Apply the exact preview after checking all local file digests again.
   *
 * @param token - current preview token.
 * @param overwrite - explicit acceptance of local modifications.
   *
 * @returns committed outcome and a retained previous-version backup.

 */
  @Remote
  async update(token: string, overwrite: boolean): Promise<SkillOperationResult> {
    return this.operation(async () => {
      const plan = this.pendingPreviews.get(token)
      if (plan === undefined) throw new ManagementError('conflict')
      const current = fileIndex(await readTree(dirname(plan.row.path), this.files.maxBytes, this.files.maxFiles))
      if (
        digest(
          JSON.stringify({
            id: plan.row.id,
            before: current,
            after: fileIndex(plan.files),
            commit: plan.preview.commit,
          }),
        ) !== token ||
        (plan.preview.localModified && !overwrite)
      )
        throw new ManagementError('conflict')
      const installed = this.files.state.installations[plan.row.id]
      if (installed === undefined) throw new ManagementError('conflict')
      await this.commitBundle(plan.directory, plan.row.name, plan.files, true, plan.workspace, {
        ...installed,
        commit: plan.preview.commit,
        files: fileIndex(plan.files),
      })
    })
  }
}
