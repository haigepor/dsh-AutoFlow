/** Desktop configuration and SHA512 adapter for the shared verified artifact transport. */
import {
  ArtifactDownload, ArtifactDownloadPaused, ARTIFACT_DOWNLOAD_SOURCES,
  type ArtifactDownloadConfig, type ArtifactDownloadArtifact, type ArtifactDownloadMeasurement,
} from '@deepseek-ai/dsh-plugin-manager/operations'
export { ArtifactDownloadPaused as DesktopDownloadPaused, ARTIFACT_DOWNLOAD_SOURCES as DESKTOP_DOWNLOAD_SOURCES }
export type { DesktopDownloadChoice, DesktopDownloadProgress } from './ipc.ts'
export type DesktopDownloadConfig = ArtifactDownloadConfig
export type DesktopDownloadMeasurement = ArtifactDownloadMeasurement
/** Size and SHA512 taken from the checked native updater feed. */
export interface DesktopDownloadArtifact { readonly url: URL; readonly version: string; readonly size: number; readonly sha512: string }

/**
 * @param directory - App-owned persistent download cache.
 * @param env - Process settings; omitted values use bounded desktop defaults.
 * @returns Validated download timing, probe, and throughput settings.
 */
export function desktopDownloadConfig(directory: string, env: NodeJS.ProcessEnv): DesktopDownloadConfig {
  const number = (name: string, fallback: number, minimum: number, maximum = 2_147_483_647): number => {
    const value = Number(env[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`desktop update: invalid ${name}`)
    return value
  }
  return { directory, idleTimeoutMs: number('DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS', 60_000, 1000),
    probeTimeoutMs: number('DSH_DESKTOP_UPDATE_PROBE_TIMEOUT_MS', 4000, 1000),
    probeBytes: number('DSH_DESKTOP_UPDATE_PROBE_BYTES', 131_072, 1024, 1_048_576),
    probeCacheMs: number('DSH_DESKTOP_UPDATE_PROBE_CACHE_MS', 300_000, 1000),
    slowWindowMs: number('DSH_DESKTOP_UPDATE_SLOW_WINDOW_MS', 30_000, 1000),
    minimumBytesPerSecond: number('DSH_DESKTOP_UPDATE_MINIMUM_BYTES_PER_SECOND', 32_768, 1),
    connections: number('DSH_DESKTOP_UPDATE_CONNECTIONS', process.platform === 'win32' ? 4 : 1, 1, 16),
    pieceBytes: number('DSH_DESKTOP_UPDATE_PIECE_BYTES', 8 * 1024 * 1024, 65536, 64 * 1024 * 1024) }
}

/** Shares interval persistence and source selection with public plugin downloads. */
export class DesktopUpdateDownload extends ArtifactDownload {
  /**
   * @param artifact - Checked native feed file, or an already normalized shared artifact.
   * @param destination - Updater-owned temporary destination.
   * @param signal - Optional updater cancellation; omission leaves pause/dispose in control.
   * @returns Verified destination; installation remains owned by the native updater.
   */
  override download(
    artifact: DesktopDownloadArtifact | ArtifactDownloadArtifact, destination: string, signal?: AbortSignal,
  ): Promise<string> {
    return super.download('sha512' in artifact ? { url: artifact.url, version: artifact.version, size: artifact.size,
      checksum: { algorithm: 'sha512', value: artifact.sha512 } } : artifact, destination, signal)
  }
}
