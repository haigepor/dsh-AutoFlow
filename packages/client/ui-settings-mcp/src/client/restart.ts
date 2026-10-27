/** Configuration restart waits for the launcher's replacement Host before reloading the browser. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'

type RestartStatus = Extract<Awaited<ReturnType<ClientRemote['pluginManager']['restartStatus']>>, { ok: true }>['value']

/**
 * Verify a new, ready Host after an explicitly accepted configuration restart.
 * @param status - process identity and recovery deadline observed before restart.
 * @param commit - authenticated restart request; teardown may interrupt its response.
 * @param signal - plugin lifetime cancellation.
 * @returns after a different Host is ready; refusal, cancellation and expiry reject.
 */
export async function waitForConfigurationRestart(
  status: RestartStatus, commit: () => Promise<boolean | undefined>, signal: AbortSignal,
): Promise<void> {
  if (!status.supported || !status.ready) throw new Error('Restart unavailable')
  const recovery = AbortSignal.any([signal, AbortSignal.timeout(status.timeoutMs)])
  const accepted = await commit().catch((_disconnectedResponse: unknown) => {
    // 停机可能中断回复；只有新进程的就绪状态可以确认重启成功。
  })
  if (accepted === false) throw new Error('Restart refused')
  while (!recovery.aborted) {
    try {
      const response = await fetch('api/plugins/restart-status', { credentials: 'same-origin', cache: 'no-store', signal: recovery })
      if (response.ok) {
        const value: unknown = await response.json()
        if (typeof value === 'object' && value !== null && 'generation' in value && typeof value.generation === 'string'
          && value.generation !== status.generation && 'ready' in value && value.ready === true) return
      } else await response.body?.cancel()
    } catch (_unavailableHost) {
      // 旧进程退出到新进程监听之间允许连接失败；统一截止信号控制重试。
      recovery.throwIfAborted()
    }
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        clearTimeout(timer)
        const reason: unknown = recovery.reason
        reject(reason instanceof Error ? reason : new DOMException('Configuration restart cancelled', 'AbortError'))
      }
      const timer = setTimeout(() => { recovery.removeEventListener('abort', abort); resolve() }, 1000)
      recovery.addEventListener('abort', abort, { once: true })
      if (recovery.aborted) abort()
    })
  }
  recovery.throwIfAborted()
}
