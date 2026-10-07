/** Preset roster, the new-task default and the read-only composition viewer for the settings section. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { writeDefaultPreset } from './settings-store.ts'

/** The read-only composition viewer over one preset. */
export interface PresetView {
  /** The preset being read. */
  id: string
  /** Display name the preset published, or its id. */
  title: string
  /** The declared child plugin list as YAML. */
  content: string
}
/** Settings page state. */
export interface AgentPresetSectionState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  saving: boolean
  /** Requested card while persistence, roster verification or blank-session synchronization is pending. */
  pendingId: string | null
  rows: readonly AgentPresetRow[]
  /** The open viewer, or null. */
  view: PresetView | null
}
const INITIAL: AgentPresetSectionState = { status: 'idle', error: null, saving: false, pendingId: null, rows: [], view: null }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Loads the roster, writes the default, and reads one composition at a time. */
export class AgentPresetSectionController {
  /** Observable roster, selection and viewer state. */
  readonly store: SnapshotStore<AgentPresetSectionState> = createSnapshotStore(INITIAL)
  private loading: Promise<void> | undefined
  private viewRequest = 0
  private rosterVersion = 0
  constructor(private readonly ctx: Context) {}

  private set(patch: Partial<AgentPresetSectionState>): void { this.store.set({ ...this.store.getSnapshot(), ...patch }) }

  /** Refresh the roster; concurrent calls share one read.
   * @returns Once the roster read settles.
   */
  load(): Promise<void> {
    return this.loading ??= this.readRoster().finally(() => { this.loading = undefined })
  }
  private async readRoster(): Promise<void> {
    const version = this.rosterVersion
    this.set({ status: 'loading', error: null })
    try {
      const result = await this.ctx.remote.agentPresets.list()
      if (version !== this.rosterVersion) return
      if (!result.ok) throw new Error(result.error.message)
      this.set({ status: 'ready', error: null, rows: result.value.presets })
    } catch (error) { if (version === this.rosterVersion) this.set({ status: 'error', error: message(error) }) }
  }

  /** Open one preset's declared composition in the viewer.
   * @param id Preset to read.
   * @returns Once the read settles; a current failure lands in `error`, while a read superseded by close or another read is ignored.
   */
  async view(id: string): Promise<void> {
    const request = ++this.viewRequest
    this.set({ error: null, view: null })
    try {
      const result = await this.ctx.remote.agentPresets.read(id)
      if (request !== this.viewRequest) return
      if (!result.ok) throw new Error(result.error.message)
      const { name, content } = result.value
      this.set({ view: { id, title: name ?? id, content } })
    } catch (error) { if (request === this.viewRequest) this.set({ error: message(error) }) }
  }
  /** Close the viewer. */
  closeView(): void { this.viewRequest++; this.set({ view: null }) }

  /** Set the default and synchronize the current blank task when supplied.
   * @param id Selected default.
   * @param sync Blank-session synchronization callback.
   * @returns Once saved and refreshed.
   */
  async makeDefault(id: string, sync?: (id: string) => Promise<string | undefined>): Promise<void> {
    if (this.store.getSnapshot().saving) return
    this.set({ saving: true, pendingId: id, error: null })
    try {
      const error = await writeDefaultPreset(this.ctx, id)
      if (error !== undefined) {
        await this.load()
        throw new Error(error)
      }
      // 写入已确认后立即反馈；写入前发起的列表读取不能覆盖新默认值。
      this.rosterVersion++
      const rows = this.store.getSnapshot().rows
      if (rows.some(row => row.id === id && row.broken === undefined)) {
        this.set({ rows: rows.map(row => ({ ...row, isDefault: row.id === id })) })
      }
      if (this.loading !== undefined) await this.loading
      await this.load()
      // 会话只同步核对后的有效默认值，读取失败时保留错误供用户重试。
      if (this.store.getSnapshot().status !== 'ready') return
      const selected = this.store.getSnapshot().rows.find(row => row.isDefault)
      if (selected !== undefined) {
        const error = await sync?.(selected.id)
        if (error !== undefined) throw new Error(error)
      }
    } catch (error) { this.set({ error: message(error) }) }
    finally { this.set({ saving: false, pendingId: null }) }
  }
}
