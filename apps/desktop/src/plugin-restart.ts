/** Installed plugin updates restart only after an idle admission check; concurrent requests share one attempt. */

/** Main-process policy and owned Electron lifecycle operations. */
export interface PluginRestartOptions {
  allowed(): boolean
  prepare(): Promise<boolean>
  release(): Promise<void>
  relaunch(): void
  quit(): void
}

/**
 * Create the main-owned plugin restart action without accepting renderer arguments.
 * @param options - Availability, idle admission check, relaunch and orderly quit.
 * @returns A coalesced action; false defers busy work, failures remain retryable.
 */
export function createPluginRestart(options: PluginRestartOptions): () => Promise<boolean> {
  let pending: Promise<boolean> | undefined
  let accepted = false
  return () => {
    if (accepted) return Promise.resolve(true)
    pending ??= Promise.resolve().then(async () => {
      if (!options.allowed() || !await options.prepare()) return false
      try {
        if (!options.allowed()) return false
        options.relaunch()
        accepted = true
        options.quit()
        return true
      } finally { if (!accepted) await options.release() }
    }).finally(() => { pending = undefined })
    return pending
  }
}
