/** Serial archive operations share progress and feedback across settings remounts. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceArchiveError } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ArchiveKey } from './locales.ts'

/** Archive state changes and confirmed permanent record removal. */
export type ArchiveOperation = 'archive' | 'restore' | 'delete'
/** One failed item remains available for an explicit retry. */
export interface ArchiveFailure { readonly id: SessionId; readonly title: string; readonly reason: 'activeFailure' | 'operationFailure' | 'deleteFailure' | 'cleanupFailure' }

/** A rejected deletion distinguishes untouched records from committed removals needing cleanup. */
export class ArchiveDeleteError extends Error {
  /** @param reason - localized report chosen from the Host's deletion outcome. */
  constructor(readonly reason: 'activeFailure' | 'deleteFailure' | 'cleanupFailure') {
    super(reason)
    this.name = 'ArchiveDeleteError'
  }
}
/** The page owns no copy of session or Workspace data. */
export interface ArchiveOperationState {
  readonly progress: { readonly done: number; readonly total: number } | null
  readonly result: { readonly operation: ArchiveOperation; readonly success: number; readonly failures: readonly ArchiveFailure[] } | null
  readonly notice: { readonly seq: number; readonly key: ArchiveKey; readonly count: number; readonly success: boolean } | null
}

/** Narrow commands and live reads closed over by the registration owner. */
export interface ArchiveCommands {
  change: (operation: ArchiveOperation, id: SessionId) => Promise<void>
  favorite: (id: SessionId, favorited: boolean) => Promise<void>
  prepareOpen: (id: SessionId) => () => void
  archived: (id: SessionId) => boolean
  title: (id: SessionId) => string
}

/** Keeps in-flight batch ownership outside the mounted page. */
export class ArchiveOperations {
  /** Current progress, unfinished items and application-wide feedback. */
  readonly state = createSnapshotStore<ArchiveOperationState>({ progress: null, result: null, notice: null })
  private readonly lifetime = new AbortController()
  private sequence = 0

  /** @param commands - existing Host-backed actions and current metadata reads. */
  constructor(private readonly commands: ArchiveCommands) {}

  private isDisposed(): boolean { return this.lifetime.signal.aborted }

  /** Stop dispatching subsequent items; an already sent Host request settles normally. */
  dispose(): void { this.lifetime.abort() }

  /** Clear a completed failure report without changing any sessions. */
  dismissResult(): void { this.state.set({ ...this.state.getSnapshot(), result: null }) }

  /** Remove the transient overlay notice. */
  dismissNotice(): void { this.state.set({ ...this.state.getSnapshot(), notice: null }) }

  /**
   * Change each distinct target serially; a failure never prevents later targets.
   * @param operation - requested archive state.
   * @param ids - explicit selection, captured before list updates arrive.
   * @param openAfter - restore and navigate only after this target succeeds.
   * @returns completion after all admitted requests settle.
   */
  async run(operation: ArchiveOperation, ids: readonly SessionId[], openAfter?: SessionId): Promise<void> {
    if (this.isDisposed() || this.state.getSnapshot().progress !== null || ids.length === 0) return
    const targets = [...new Set(ids)]
    const open = openAfter !== undefined && operation === 'restore' ? this.commands.prepareOpen(openAfter) : undefined
    const failures: ArchiveFailure[] = []
    let success = 0
    this.state.set({ progress: { done: 0, total: targets.length }, result: null, notice: null })
    for (const [index, id] of targets.entries()) {
      if (this.isDisposed()) break
      const title = this.commands.title(id)
      try {
        // Another client may already have committed the requested state.
        if (operation === 'delete' || this.commands.archived(id) !== (operation === 'archive')) await this.commands.change(operation, id)
        success++
        if (!this.isDisposed() && openAfter === id) open?.()
      } catch (reason: unknown) {
        const active = reason instanceof Error && reason.name === 'WorkspaceArchiveError'
          && (reason as WorkspaceArchiveError).rpcError.code === 'workspace/session-active'
        failures.push({ id, title, reason: reason instanceof ArchiveDeleteError ? reason.reason : active ? 'activeFailure' : operation === 'delete' ? 'deleteFailure' : 'operationFailure' })
      }
      if (!this.isDisposed()) this.state.set({ ...this.state.getSnapshot(), progress: { done: index + 1, total: targets.length } })
    }
    if (this.isDisposed()) return
    this.state.set({
      progress: null,
      result: failures.length === 0 ? null : { operation, success, failures },
      notice: { seq: ++this.sequence, key: failures.length === 0 ? operation === 'archive' ? 'archiveDone' : operation === 'restore' ? 'restoreDone' : 'deleteDone' : 'partial', count: success, success: failures.length === 0 },
    })
  }

  /** Retry only the previous operation's unfinished targets. @returns completion of that batch. */
  async retry(): Promise<void> {
    const result = this.state.getSnapshot().result
    if (result !== null) await this.run(result.operation, result.failures.map(item => item.id))
  }

  /**
   * Save an independent bookmark through the Host preferences.
   * @param id - Session identity.
   * @param favorited - requested favorite state.
   * @returns completion after the Host responds.
   */
  async favorite(id: SessionId, favorited: boolean): Promise<void> {
    if (this.isDisposed() || this.state.getSnapshot().progress !== null) return
    this.state.set({ ...this.state.getSnapshot(), progress: { done: 0, total: 1 }, notice: null })
    let success = true
    try { await this.commands.favorite(id, favorited) } catch (_error: unknown) { success = false }
    if (this.isDisposed()) return
    this.state.set({ ...this.state.getSnapshot(), progress: null,
      notice: { seq: ++this.sequence, key: success ? favorited ? 'favoriteDone' : 'unfavoriteDone' : 'favoriteFailed', count: 1, success } })
  }
}
