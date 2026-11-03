/** User-authorized downloads and separate installation of one version-bound Desktop release. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { gt, valid } from 'semver'
import type { DesktopUpdateState } from './ipc.ts'
import { DesktopUpdateHttpExecutor } from './update-http-executor.ts'
import { DesktopUpdatePreparationError } from './update-error.ts'
import { DesktopDownloadPaused, type DesktopDownloadProgress, type DesktopUpdateDownload } from './update-download.ts'
import { parseDesktopReleaseNotes, type DesktopReleaseNotes } from './update-release-notes.ts'

const { autoUpdater, CancellationToken } = electronUpdater

/** Owns one updater target until its download and installation settle. */
export class DesktopUpdateCoordinator {
  private current: DesktopUpdateState = { phase: 'idle' }
  private candidate: string | undefined
  private releaseNotes: DesktopReleaseNotes | undefined
  private downloaded = false
  private disposed = false
  private checkOperation: Promise<DesktopUpdateState> | undefined
  private downloadOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined
  private transport: DesktopUpdateHttpExecutor | undefined
  private cancellation: InstanceType<typeof CancellationToken> | undefined
  private pauseRequested = false
  private sourceRestart = false

  private readonly onProgress = (progress: ProgressInfo): void => {
    if (this.downloadOperation === undefined || this.downloaded) return
    const percent = Math.min(100, Math.max(0, progress.percent))
    const download = this.resumable !== undefined && !this.resumable.isRunning ? {
      ...this.resumable.state, stage: 'downloading' as const, source: 'github',
      transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond,
      ...(progress.bytesPerSecond > 0
        ? { remainingSeconds: Math.ceil((progress.total - progress.transferred) / progress.bytesPerSecond) } : {}),
    } : this.current.download
    this.setState({ ...this.current, phase: percent >= 100 ? 'verifying' : 'downloading', ...this.target(), percent,
      ...(download === undefined ? {} : { download }) })
  }

  private readonly onDownloaded = (info: UpdateInfo): void => {
    if (this.downloadOperation === undefined || info.version !== this.candidate) return
    this.downloaded = true
  }

  private readonly onError = (error: Error): void => {
    // Check/download promises own their failures. Installation can fail after quitAndInstall returns.
    if (this.current.phase === 'installing') {
      this.setState(this.failure(error, 'install'))
    }
  }

  /**
   * @param publish - Receives observable states for every Desktop window.
   * @param beforeRestart - Completes task authorization, admission locking, and owned-process shutdown.
   * Approved means the shell already received installation consent.
   * @param updater - Process-owned Electron updater, replaceable at the network/platform test boundary.
   * @param enabled - Whether this process has a packaged update source.
   * @param currentVersion - Actual installed application version.
   * @param channel - Installed package channel; omitted test/local callers retain nightly.
   * @param downloadResult - Once per completed download attempt, including platform preparation failures.
   * @param resumable - Shell-owned full-file download controls; omission retains the native-only transport.
   * @param transport - Explicit Electron transport for runtime qualification; omission creates the production transport for autoUpdater.
   */
  constructor(
    private readonly publish: (state: DesktopUpdateState) => DesktopUpdateState,
    private readonly beforeRestart: (confirmation: 'required' | 'approved') => Promise<boolean>,
    private readonly updater: AppUpdater = autoUpdater,
    private readonly enabled: () => boolean = () => app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml')),
    private readonly currentVersion: () => string = () => app.getVersion(),
    private readonly downloadResult?: (success: boolean, reason?: string) => void,
    private readonly channel: 'nightly' | 'latest' = 'nightly',
    private readonly resumable?: DesktopUpdateDownload,
    transport?: DesktopUpdateHttpExecutor,
  ) {
    this.transport = transport
    if (updater === autoUpdater || transport !== undefined) {
      // electron-updater omits this internal transport property from its public declarations.
      // Real-Electron qualification exercises the pinned dependency integration.
      const transportOwner = updater as AppUpdater & { httpExecutor: DesktopUpdateHttpExecutor }
      this.transport ??= new DesktopUpdateHttpExecutor(
        Number(process.env.DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS ?? 60_000),
        (authInfo, callback) => { updater.emit('login', authInfo, callback) },
        resumable,
      )
      transportOwner.httpExecutor = this.transport
    }
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.updater.channel = channel
    this.updater.allowPrerelease = channel === 'nightly'
    // Selecting a channel can enable downgrade in electron-updater.
    this.updater.allowDowngrade = false
    this.updater.on('download-progress', this.onProgress)
    this.updater.on('update-downloaded', this.onDownloaded)
    this.updater.on('error', this.onError)
  }

  /** Latest observable state; complete download identity remains main-process-owned. */
  get state(): DesktopUpdateState { return this.current }

  /** @param progress - Transport-owned byte counts; only the native downloaded event can mark readiness. */
  transfer(progress: DesktopDownloadProgress): void {
    if (this.downloadOperation === undefined || this.downloaded) return
    this.setState({ ...this.current, download: progress,
      phase: progress.stage === 'verifying' ? 'verifying' : 'downloading',
      percent: progress.total === 0 ? 0 : progress.transferred / progress.total * 100 })
  }

  /** @param value - Shell-supplied source preference, validated and persisted by the download owner. */
  async selectSource(value: unknown): Promise<void> {
    this.assertLive()
    if (this.resumable === undefined || this.downloaded || this.installOperation !== undefined || this.current.phase === 'verifying') {
      throw new Error('desktop update: download controls unavailable')
    }
    await this.resumable.select(value)
    if (this.downloadOperation !== undefined && !this.resumable.isRunning) {
      this.sourceRestart = true
      this.cancellation?.cancel()
    }
    this.setState({ ...this.current, download: this.resumable.state })
  }

  /** Stop a full download and await its saved checkpoint; running model tasks are unaffected. */
  async pauseDownload(): Promise<void> {
    this.assertLive()
    if (this.resumable === undefined || this.downloadOperation === undefined || this.downloaded) return
    this.pauseRequested = true
    this.resumable.pause()
    this.cancellation?.cancel()
    await this.downloadOperation
  }

  /**
   * Check metadata without downloading, joining any current check.
   * @param manual - Whether a failed check must remain visible in the status indicator.
   * @returns The check result, including a silent automatic failure when applicable.
   */
  async check(manual = false): Promise<DesktopUpdateState> {
    this.assertLive()
    if (this.downloadOperation !== undefined || this.installOperation !== undefined || this.downloaded) return this.current
    if (!manual && this.current.download?.stage === 'paused') return this.current
    if (!manual && this.current.phase === 'error' && this.current.failedOperation === 'download') return this.current
    this.checkOperation ??= Promise.resolve().then(() => this.doCheck())
      .finally(() => { this.checkOperation = undefined })
    const result = await this.checkOperation
    if (manual && result.phase === 'error') this.setState(result)
    return result
  }

  /**
   * @param version - Version shown in the user's download confirmation.
   * @returns Download readiness or failure, without authorizing installation.
   */
  async download(version: string): Promise<DesktopUpdateState> {
    this.assertLive()
    if (this.downloaded || this.installOperation !== undefined) return this.current
    this.downloadOperation ??= Promise.resolve().then(async () => {
      await this.checkOperation
      this.assertLive()
      if (this.candidate === undefined) throw new Error('desktop update: no checked update is available')
      if (version !== this.candidate) throw new Error('desktop update: download confirmation is stale')
      this.setState({ phase: 'downloading', version, percent: 0,
        ...(this.resumable === undefined ? {} : { download: this.resumable.state }) })
      this.pauseRequested = false
      const differential = this.updater.disableDifferentialDownload
      try {
        for (;;) {
          this.sourceRestart = false
          // A manually selected mirror needs the full-file transport; automatic mode retains native delta updates.
          if (this.resumable !== undefined && !['auto', 'github'].includes(this.resumable.state.choice.source)) {
            this.updater.disableDifferentialDownload = true
          }
          this.cancellation = this.resumable === undefined ? undefined : new CancellationToken()
          try { await this.updater.downloadUpdate(this.cancellation) }
          catch (error) {
            if (this.interruption() === 'source') { this.updater.disableDifferentialDownload = true; continue }
            throw error
          }
          break
        }
        if (!this.downloaded) throw new Error('desktop update: platform preparation did not report readiness')
        try { await this.resumable?.complete() }
        catch (error) { console.warn('desktop update: could not remove the completed partial cache', error) }
        this.downloadResult?.(true)
        return this.setState({ phase: 'ready', version })
      } catch (error) {
        this.downloaded = false
        if (this.interruption() === 'pause' || error instanceof DesktopDownloadPaused) {
          return this.setState({ phase: 'available', version,
            ...(this.resumable === undefined ? {} : { download: { ...this.resumable.state, stage: 'paused' } }) })
        }
        this.downloadResult?.(false, error instanceof DesktopUpdatePreparationError ? error.kind : 'download_failed')
        return this.setState(this.failure(error, 'download'))
      } finally { this.cancellation?.dispose(); this.cancellation = undefined; this.updater.disableDifferentialDownload = differential }
    }).finally(() => { this.downloadOperation = undefined })
    return this.downloadOperation
  }

  /**
   * Install a prepared target after a separate user confirmation.
   * @param version - Exact version displayed in the confirmation, never a renderer-selected URL.
   * @param confirmation - Shell-owned installation consent for this version; task-stop consent is still checked separately.
   * @returns Installation handoff or a recoverable preparation error.
   */
  async install(version: string, confirmation: 'required' | 'approved' = 'required'): Promise<DesktopUpdateState> {
    this.assertLive()
    if (!this.downloaded || this.downloadOperation !== undefined || version !== this.candidate) throw new Error('desktop update: confirmed target is not ready')
    this.installOperation ??= Promise.resolve().then(async () => {
      this.setState({ phase: 'installing', version })
      try {
        if (!await this.beforeRestart(confirmation)) return this.setState({ phase: 'ready', version })
        this.assertLive()
        this.updater.quitAndInstall(true, true)
        return this.current
      } catch (error) {
        if (this.current.phase === 'error' && this.current.failedOperation === 'install') return this.current
        return this.setState(this.failure(error, 'install'))
      }
    }).finally(() => { this.installOperation = undefined })
    return this.installOperation
  }

  /** Remove owned listeners and prevent pending library operations from publishing into closed UI. */
  dispose(): void {
    this.disposed = true
    this.resumable?.dispose()
    this.cancellation?.cancel()
    this.updater.off('download-progress', this.onProgress)
    this.updater.off('update-downloaded', this.onDownloaded)
    // Pending updater promises can still emit EventEmitter errors during shutdown.
    void Promise.allSettled([this.checkOperation, this.downloadOperation, this.installOperation])
      .then(() => { this.updater.off('error', this.onError) })
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('desktop update: coordinator is disposed')
  }

  private interruption(): 'pause' | 'source' | undefined {
    return this.pauseRequested ? 'pause' : this.sourceRestart ? 'source' : undefined
  }

  private setState(state: DesktopUpdateState): DesktopUpdateState {
    if (this.releaseNotes !== undefined && state.version === this.releaseNotes.version) {
      state = { ...state, releaseNotes: this.releaseNotes }
    }
    if (!this.disposed) {
      this.current = state
      this.publish(state)
    }
    return state
  }

  private failure(error: unknown, failedOperation: 'check' | 'download' | 'install'): DesktopUpdateState {
    return { phase: 'error', ...this.target(), failedOperation,
      ...(this.resumable === undefined || failedOperation !== 'download' ? {} : { download: this.resumable.state }),
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof DesktopUpdatePreparationError ? {
        preparationFailure: error.kind,
        ...(error.technicalDetails === undefined ? {} : { technicalDetails: error.technicalDetails }),
      } : {}) }
  }

  private target(): { version?: string } {
    return this.candidate === undefined ? {} : { version: this.candidate }
  }

  private async doCheck(): Promise<DesktopUpdateState> {
    try {
      this.assertLive()
      if (!this.enabled()) throw new Error('desktop update: this application has no packaged update source')
      const result = await this.updater.checkForUpdates()
      if (result === null) throw new Error('desktop update: no check result was returned')
      const version = result.updateInfo.version
      if (valid(version) === null) throw new Error('desktop update: feed version is invalid')
      if (this.channel === 'latest' && version.includes('-')) throw new Error('desktop update: latest feed contains a prerelease')
      this.candidate = result.isUpdateAvailable && gt(version, this.currentVersion()) ? version : undefined
      this.releaseNotes = undefined
      if (this.candidate !== undefined && 'dshReleaseNotes' in result.updateInfo) {
        try { this.releaseNotes = parseDesktopReleaseNotes(result.updateInfo.dshReleaseNotes, version) }
        catch (error) { console.warn('desktop update: optional release notes rejected', error) }
      }
      this.transport?.prepare({ version, files: result.updateInfo.files })
      return this.setState(this.candidate === undefined ? { phase: 'idle' } : { phase: 'available', version,
        ...(this.resumable === undefined ? {} : { download: this.resumable.state }) })
    } catch (error) {
      return this.failure(error, 'check')
    }
  }
}
