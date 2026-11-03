/** Main-owned update confirmations; closing or replacing a dialog never grants installation permission. */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron'
import type { DesktopLocale } from './locale.ts'
import type { DesktopUpdateOverlays, DesktopUpdateOverlay } from './update-overlay.ts'
import type { DesktopUpdateState } from './ipc.ts'
import type { DesktopMessages } from './locale.ts'

/** Channels available only to the isolated update-dialog document. */
export const UPDATE_DIALOG_IPC = { status: 'dsh-update-dialog:status', changed: 'dsh-update-dialog:changed',
  respond: 'dsh-update-dialog:respond', control: 'dsh-update-dialog:download-control' } as const

/** Text and choices supplied by the main process, never by product documents. */
export interface UpdateDialogView {
  /** Identifies the displayed choices; a response from an older prompt is rejected. */
  readonly revision: number
  readonly locale: string
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly buttons: readonly string[]
  readonly cancelId: number
  readonly closeLabel: string
  readonly technicalDetails: string
  readonly technicalDetailsLabel: string
  readonly download?: { readonly state: DesktopUpdateState; readonly messages: DesktopMessages }
}

/** Electron message options with separately expandable, main-owned diagnostics. */
export interface UpdateDialogOptions extends MessageBoxOptions {
  readonly technicalDetails?: string
  readonly download?: DesktopUpdateState
}

/** The document can select only a displayed response index. */
export interface UpdateDialogApi {
  status(): Promise<UpdateDialogView | null>
  respond(revision: number, index: number): Promise<void>
  subscribe(listener: (view: UpdateDialogView | null) => void): () => void
  control?(action: string, version: string, choice?: unknown): Promise<void>
}

// main.ts's protocol.handle shell route serves this document and its renderer assets; the modal requires that route.
const page = 'dsh-app://shell/update-dialog.html'

/** One fading backdrop with replaceable confirmation content; aborted checks and mandatory policy cancel ordinary prompts. */
export class DesktopUpdateDialog {
  private disposed = false
  private revision = 0
  private view: DesktopUpdateOverlay | undefined
  private parent: BrowserWindow | undefined
  private closing: ReturnType<typeof setTimeout> | undefined
  private active: { view: UpdateDialogView; finish: (index: number, retain?: boolean) => void } | undefined

  /** Focus the current explanation or confirmation without replacing it or granting permission. */
  focus(): void {
    if (this.active === undefined || this.parent?.isDestroyed() !== false) return
    this.parent.focus()
    this.view?.webContents.focus()
  }

  /** Whether a shell prompt is awaiting a response. */
  get isOpen(): boolean { return this.active !== undefined }

  /**
   * @param preload - Bundled isolated preload.
   * @param locale - Shell-owned copy or a reader of the current UI language.
   * @param overlays - Application-owned view creation and input tracking.
   * @param controlDownload - Validated download commands; omitted callers cannot expose download controls.
   */
  constructor(private readonly preload: string, private readonly locale: DesktopLocale | (() => DesktopLocale),
    private readonly overlays: Pick<DesktopUpdateOverlays, 'create'>,
    private readonly controlDownload?: (action: unknown, version: unknown, choice: unknown) => Promise<void>) {
    ipcMain.handle(UPDATE_DIALOG_IPC.status, (event) => { this.owned(event); return this.active?.view ?? null })
    ipcMain.handle(UPDATE_DIALOG_IPC.respond, (event, revision: unknown, index: unknown) => {
      this.owned(event)
      const active = this.active
      if (active === undefined || revision !== active.view.revision) throw new Error('desktop update: stale dialog response')
      if (typeof index !== 'number' || !Number.isInteger(index)
        || (index !== active.view.cancelId && (index < 0 || index >= active.view.buttons.length))) {
        throw new Error('desktop update: invalid dialog response')
      }
      active.finish(index)
    })
    ipcMain.handle(UPDATE_DIALOG_IPC.control, (event, action: unknown, version: unknown, choice: unknown) => {
      this.owned(event)
      if (this.active?.view.download === undefined || this.controlDownload === undefined) throw new Error('desktop update: no download dialog is active')
      return this.controlDownload(action, version, choice)
    })
  }

  /** @param state - New measured progress; preserve the same prompt revision, focus, and cancellation semantics. */
  updateDownload(state: DesktopUpdateState): void {
    if (this.active?.view.download === undefined) return
    this.active.view = { ...this.active.view, download: { ...this.active.view.download, state } }
    this.view?.webContents.send(UPDATE_DIALOG_IPC.changed, this.active.view)
  }

  /**
   * @param parent - Window blocked by this confirmation.
   * @param options - Main-owned localized content, response choices, and optional cancellation signal.
   * @returns A displayed response, or cancellation on replacement, abort, close, or load failure; backdrop dismissal fades independently.
   */
  show(parent: BrowserWindow, options: UpdateDialogOptions): Promise<MessageBoxReturnValue> {
    const locale = typeof this.locale === 'function' ? this.locale() : this.locale
    const buttons = options.buttons ?? [locale.messages.updateAcknowledge]
    const cancelId = options.cancelId ?? buttons.length - 1
    if (this.disposed || options.signal?.aborted === true || parent.isDestroyed()) {
      return Promise.resolve({ response: cancelId, checkboxChecked: false })
    }
    if (this.parent !== parent) { this.cancel(); this.close() }
    this.active?.finish(this.active.view.cancelId, true)
    clearTimeout(this.closing)
    this.closing = undefined
    const existing = this.view
    const surface = existing ?? this.overlays.create(parent, this.preload)
    this.view = surface
    this.parent = parent
    const view: UpdateDialogView = { revision: ++this.revision, locale: locale.id, title: options.title ?? '', message: options.message,
      detail: options.detail ?? '', buttons, cancelId, closeLabel: locale.messages.updateClose,
      technicalDetails: options.technicalDetails ?? '', technicalDetailsLabel: locale.messages.updateTechnicalDetails,
      ...(options.download === undefined ? {} : { download: { state: options.download, messages: locale.messages } }) }
    return new Promise((resolve) => {
      const abort = (): void => { finish(cancelId) }
      const finish = (response: number, retain = false): void => {
        if (this.active?.view.revision !== view.revision) return
        this.active = undefined
        options.signal?.removeEventListener('abort', abort)
        if (!retain && !surface.webContents.isDestroyed()) {
          surface.webContents.send(UPDATE_DIALOG_IPC.changed, null)
          this.closing = setTimeout(() => { this.close() }, 150)
        }
        resolve({ response, checkboxChecked: false })
      }
      this.active = { view, finish }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (existing !== undefined) { surface.webContents.send(UPDATE_DIALOG_IPC.changed, view); return }
      const failed = (): void => { if (this.view === surface) { this.cancel(); this.close() } }
      surface.webContents.once('destroyed', failed)
      surface.webContents.once('render-process-gone', failed)
      surface.webContents.once('preload-error', failed)
      surface.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault() })
      surface.webContents.on('will-redirect', (event) => { event.preventDefault() })
      surface.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      void surface.loadURL(page).catch(failed)
    })
  }

  /** Cancel the displayed prompt without authorizing any operation. */
  cancel(): void { this.active?.finish(this.active.view.cancelId) }

  /** Close the document and detach its private IPC handlers. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    this.close()
    ipcMain.removeHandler(UPDATE_DIALOG_IPC.status)
    ipcMain.removeHandler(UPDATE_DIALOG_IPC.respond)
    ipcMain.removeHandler(UPDATE_DIALOG_IPC.control)
  }

  private close(): void {
    clearTimeout(this.closing)
    this.closing = undefined
    const surface = this.view
    this.view = undefined
    this.parent = undefined
    surface?.destroy()
  }

  private owned(event: IpcMainInvokeEvent): void {
    const surface = this.view
    if (surface === undefined || event.sender !== surface.webContents
      || event.senderFrame !== surface.webContents.mainFrame || event.senderFrame.url !== page) {
      throw new Error('desktop update: rejected unowned dialog renderer')
    }
  }
}
