/** Native restart is armed only after approval; concurrent renderer requests share one decision. */

/** Main-process policy and owned Electron lifecycle operations. */
export interface PluginRestartOptions {
  allowed(): boolean
  confirm(): Promise<boolean>
  relaunch(): void
  quit(): void
}

/**
 * Create the main-owned plugin restart action without accepting renderer arguments.
 * @param options - Availability, existing native confirmation, relaunch and orderly quit.
 * @returns A coalesced action; false when unavailable or declined, retryable on failure.
 */
export function createPluginRestart(options: PluginRestartOptions): () => Promise<boolean> {
  let pending: Promise<boolean> | undefined
  let accepted = false
  return () => {
    if (accepted) return Promise.resolve(true)
    pending ??= Promise.resolve().then(async () => {
      if (!options.allowed() || !await options.confirm() || !options.allowed()) return false
      options.relaunch()
      accepted = true
      options.quit()
      return true
    }).finally(() => { pending = undefined })
    return pending
  }
}
