/** Authenticated Web recovery after the owning launcher replaces its Host. */
import { waitForAbortableDelay } from '@deepseek-ai/dsh-client-ui-primitives'

/** Wait for work to finish before requesting one plugin restart; closing its card does not cancel this operation.
 * @param attempt Carrier-owned idle check and restart request; false defers without interrupting work.
 * @param signal Plugin lifetime, not dialog visibility.
 * @param waiting Publish whether active work deferred the restart.
 * @returns True after the carrier accepts one restart; failures remain retryable.
 */
export async function waitForAutomaticPluginRestart(
  attempt: () => Promise<boolean>, signal: AbortSignal, waiting: (value: boolean) => void,
): Promise<boolean> {
  while (!signal.aborted) {
    const accepted = await attempt()
    signal.throwIfAborted()
    waiting(!accepted)
    if (accepted) return true
    await waitForAbortableDelay(1000, signal)
  }
  signal.throwIfAborted()
  return false
}

/** Public readiness response contains no process arguments or authentication credentials. */
export interface UpdateRestartStatus {
  readonly generation: string
  readonly supported: boolean
  readonly ready: boolean
  readonly timeoutMs: number
}

/**
 * Request a fresh Host and wait for a different, ready process before reloading the page.
 * A dropped commit response is expected during teardown; only new readiness confirms success.
 * @param status - Readiness observed before requesting restart.
 * @param commit - Authenticated restart request; may wait for active work before acceptance.
 * @param signal - Plugin lifetime; cancellation stops retries and prevents a late reload.
 * @returns When a replacement Host is ready; throws on unsupported launch or timeout.
 */
export async function waitForUpdatedWebHost(
  status: UpdateRestartStatus, commit: () => Promise<boolean | undefined>, signal: AbortSignal,
): Promise<void> {
  if (!status.supported) throw new Error('This launcher does not support restart')
  // 停机可能中断提交回复；请求失败不会被当作成功，后续必须确认新进程已就绪。
  const accepted = await commit().catch((_disconnectedCommit: unknown) => {
    // 新进程就绪是最终确认；停机造成的提交连接失败只由恢复截止时间裁定。
  })
  if (accepted === false) throw new Error('The Host refused restart; retry after plugin operations finish')
  const deadline = AbortSignal.timeout(status.timeoutMs)
  const recovery = AbortSignal.any([signal, deadline])
  while (!recovery.aborted) {
    try {
      const response = await fetch('api/plugins/restart-status', {
        credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([recovery, AbortSignal.timeout(5000)]),
      })
      if (response.ok) {
        const result: unknown = await response.json()
        if (typeof result === 'object' && result !== null && 'generation' in result
          && typeof result.generation === 'string' && result.generation !== status.generation
          && 'ready' in result && result.ready === true) return
      } else await response.body?.cancel()
    } catch (_hostUnavailable) {
      // 旧进程退出与新进程绑定端口之间连接会失败；取消与截止时间由同一个信号控制。
      recovery.throwIfAborted()
    }
    await waitForAbortableDelay(1000, recovery)
  }
  recovery.throwIfAborted()
}
