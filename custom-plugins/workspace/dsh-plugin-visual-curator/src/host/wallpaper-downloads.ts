/** Active download counters are scoped to one worker lifetime and never modify historical task records. */
import type { WallpaperDownloadProgress } from '../shared/wallpaper.ts'

/** Ephemeral transfer state is shared by every authorized canvas read of the owning workflow instance. */
export class WallpaperDownloads {
  private readonly runs = new Map<string, Map<string, { value: WallpaperDownloadProgress; close(): void }>>()
  /** @param runId Owning worker. @param imageId Frozen source image. @param signal Worker lifetime. @param initial Initial acquisition phase. @returns An observer released on completion, failure, replacement or abort. */
  begin(runId: string, imageId: string, signal: AbortSignal, initial: WallpaperDownloadProgress) {
    this.runs.get(runId)?.get(imageId)?.close()
    const images = this.runs.get(runId) ?? new Map<string, { value: WallpaperDownloadProgress; close(): void }>()
    this.runs.set(runId, images)
    let active = true
    const close = () => {
      if (!active) return
      active = false; signal.removeEventListener('abort', close); images.delete(imageId)
      if (!images.size) this.runs.delete(runId)
    }
    const entry = { value: initial, close }; images.set(imageId, entry)
    signal.addEventListener('abort', close, { once: true }); if (signal.aborted) close()
    return { update(value: WallpaperDownloadProgress) { if (active && !signal.aborted) entry.value = value }, close }
  }
  /** @param runId Authorized task identity. @param imageId Frozen source identity. @returns A counter snapshot only while its worker is active. */
  read(runId: string, imageId: string): WallpaperDownloadProgress | undefined {
    const value = this.runs.get(runId)?.get(imageId)?.value
    return value ? { ...value } : undefined
  }
}
