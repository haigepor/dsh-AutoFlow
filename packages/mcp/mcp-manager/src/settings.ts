/** Profile-owned MCP management; connection and Session lifetimes stay with their existing owners. */
import { createHash, randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { interpolate, type Entry } from '@deepseek-ai/cordis-plugin-loader'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-mcp-client/connections'
import type { PluginInfo, PluginEntryId } from '@deepseek-ai/dsh-plugin-manager/types'
import type { McpServerDraft, McpServerRow, McpServerDetail, McpServerList, McpWriteResult } from './types.ts'
import { draftOf, McpSettingsError, rawConfig, validateConfig } from './host/configuration.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Redacted profile MCP management exposed to trusted settings clients. */
    mcpSettings: McpSettings
  }
}

const CLIENT = '@deepseek-ai/dsh-mcp-client'

/** Persistent MCP controls and redacted connection status for the Settings page. */
export default class McpSettings extends TypertRemoteService {
  static inject = ['configEditor', 'pluginManager', 'mcpConnections', 'loader', 'profileContext']

  constructor(private readonly owner: Context) {
    super(owner, 'mcpSettings')
    const changed = (): void => { owner.emit('mcp-settings/changed') }
    owner.on('mcp-connections/changed', changed)
    owner.on('app-boot/config-reload', changed)
    owner.on('plugin-manager/changed', changed)
  }

  /**
   * Read the configured server list and new-entry defaults.
   * @returns configured entries, including disabled and disconnected servers, without credentials.
   */
  @Remote
  async list(): Promise<McpServerList> {
    const rows = (await this.owner.pluginManager.listPlugins()).filter(row => row.moduleName === CLIENT)
    const servers = rows.flatMap((info) => {
      const entry = this.findEntry(info.entryId)
      return entry === undefined ? [] : [this.describe(entry, info)]
    })
    const defaults = draftOf(validateConfig({ serverName: 'server', transport: 'stdio', command: 'node' }))
    return { servers, defaults: { ...defaults, serverName: '', command: '' } }
  }

  /**
   * Read one configured server for its editor.
   * @param id - entry identity returned by list.
   * @returns complete redacted editor values.
   */
  @Remote
  async detail(id: PluginEntryId): Promise<McpServerDetail> {
    const { entry, info } = await this.lookup(id)
    return { ...this.describe(entry, info), config: draftOf(this.resolved(entry)) }
  }

  /**
   * Add a validated profile entry; server startup failures remain visible as connection state.
   * @param draft - server configuration with explicit new secret values.
   * @param enabled - whether the new server starts immediately.
   * @returns saved application state or a redacted rejection.
   */
  @Remote
  async create(draft: McpServerDraft, enabled: boolean): Promise<McpWriteResult> {
    return this.change(async () => {
      const config = rawConfig(draft)
      const resolved = validateConfig(config)
      this.assertUnique(resolved.serverName)
      const patchId = `mcp-${randomUUID()}`
      await this.owner.configEditor.insert({ id: patchId, name: CLIENT, config, disabled: !enabled }, () => {
        this.assertUnique(resolved.serverName)
      })
      const info = (await this.owner.pluginManager.listPlugins()).find(row => row.patchId === patchId)
      if (info === undefined) throw new McpSettingsError('apply-failed')
      const { entry } = await this.lookup(info.entryId)
      return { status: 'saved', application: 'applied', server: this.describe(entry, info) }
    })
  }

  /**
   * Save an active or disabled server, preserving untouched expressions and hidden credentials.
   * @param id - configured entry identity.
   * @param draft - complete editor values; null secrets preserve their saved key.
   * @param expectedRevision - revision read when the editor opened.
   * @returns application state or a conflict/validation rejection.
   */
  @Remote
  async update(id: PluginEntryId, draft: McpServerDraft, expectedRevision: string): Promise<McpWriteResult> {
    return this.change(async () => {
      const { entry, info } = await this.lookup(id)
      if (info.readOnlyReason !== undefined) throw new McpSettingsError('read-only')
      const validate = (raw: Record<string, unknown>): void => {
        const config = validateConfig(interpolate(entry.ctx, raw) as Record<string, unknown>)
        this.assertUnique(config.serverName, entry)
      }
      await this.owner.configEditor.edit(entry, (raw) => {
        if (this.revision(entry) !== expectedRevision) throw new McpSettingsError('conflict')
        const next = rawConfig(draft, raw, this.resolved(entry))
        validate(next)
        return next
      }, { validate })
      return { status: 'saved', application: 'applied', server: this.describe(entry, info) }
    })
  }

  /**
   * Persist a server's desired enablement and reconcile its connection.
   * @param id - configured entry identity.
   * @param enabled - desired activation.
   * @returns independently observed save and application outcome.
   */
  @Remote
  async setEnabled(id: PluginEntryId, enabled: boolean): Promise<McpWriteResult> {
    return this.change(async () => {
      const { info } = await this.lookup(id)
      if (info.readOnlyReason !== undefined) throw new McpSettingsError('read-only')
      const result = await this.owner.pluginManager.setPluginEnabled(id, enabled)
      if (result.application !== 'applied' && result.application !== 'restart-required') throw new McpSettingsError('apply-failed')
      const current = await this.lookup(id)
      return { status: 'saved', application: result.application, server: this.describe(current.entry, current.info) }
    })
  }

  /**
   * Restart one server while retaining conversations and saved configuration.
   * @param id - enabled, profile-owned MCP entry.
   * @returns readiness after the old connection is disposed and the replacement settles.
   */
  @Remote
  async restart(id: PluginEntryId): Promise<McpWriteResult> {
    return this.change(async () => {
      const run = async (): Promise<McpWriteResult> => {
        const { entry, info } = await this.lookup(id)
        if (info.readOnlyReason !== undefined) throw new McpSettingsError('read-only')
        if (!info.enabled) throw new McpSettingsError('invalid-config')
        if (entry.fiber === undefined) throw new McpSettingsError('apply-failed')
        await entry.fiber.restart()
        await this.owner.loader.await()
        const current = await this.lookup(id)
        return { status: 'saved', application: 'applied', server: this.describe(current.entry, current.info) }
      }
      const hmr = this.owner.get('hmr')
      return hmr === undefined ? run() : hmr.runExclusive(run)
    })
  }

  private findEntry(id: PluginEntryId): Entry | undefined {
    return [...this.owner.loader.entries()].find(entry => entry.id === id && entry.options.name === CLIENT)
  }

  private async lookup(id: PluginEntryId): Promise<{ entry: Entry; info: PluginInfo }> {
    const info = (await this.owner.pluginManager.listPlugins()).find(row => row.entryId === id && row.moduleName === CLIENT)
    const entry = this.findEntry(id)
    if (info === undefined || entry === undefined) throw new McpSettingsError('not-found')
    return { entry, info }
  }

  private resolved(entry: Entry): ReturnType<typeof validateConfig> {
    return validateConfig(interpolate(entry.ctx, entry.options.config ?? {}) as Record<string, unknown>)
  }

  private revision(entry: Entry): string {
    return createHash('sha256').update(JSON.stringify(entry.options)).digest('hex')
  }

  private describe(entry: Entry, info: PluginInfo): McpServerRow {
    const raw = (entry.options.config ?? {}) as Record<string, unknown>
    const connection = this.owner.mcpConnections.snapshot(entry.fiber)
    return {
      id: info.entryId, revision: this.revision(entry),
      serverName: typeof raw.serverName === 'string' ? raw.serverName : entry.options.id,
      transport: raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      enabled: info.enabled,
      phase: !info.enabled ? 'disabled' : connection?.phase ?? (info.fiberPhase === 'failed' ? 'failed' : 'connecting'),
      tools: connection?.tools ?? [], readOnly: info.readOnlyReason !== undefined,
    }
  }

  private assertUnique(name: string, except?: Entry): void {
    for (const entry of this.owner.configEditor.entries()) {
      if (entry === except || entry.options.name !== CLIENT) continue
      const raw = interpolate(entry.ctx, entry.options.config ?? {}) as Record<string, unknown>
      if (raw.serverName === name) throw new McpSettingsError('duplicate-name')
    }
  }

  private async change(run: () => Promise<McpWriteResult>): Promise<McpWriteResult> {
    try {
      return await run()
    } catch (error) {
      if (!(error instanceof McpSettingsError)) this.owner.logger.error('MCP settings operation failed', error)
      return { status: 'rejected', code: error instanceof McpSettingsError ? error.code : 'apply-failed' }
    } finally {
      this.owner.emit('mcp-settings/changed')
    }
  }
}
