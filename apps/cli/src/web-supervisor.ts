/** Fresh-process Web restart, retaining the original command, environment, and bound port. */
import { spawn, type ChildProcess } from 'node:child_process'
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from './process-shutdown.ts'

/** Private marker is accepted only together with Node's parent IPC channel. */
export const WEB_CHILD_ENV = 'DSH_WEB_SUPERVISED_CHILD'

/** Read only messages from the owned Node child; arbitrary IPC payloads are ignored. */
function readyPort(message: unknown): number | undefined {
  if (typeof message !== 'object' || message === null || !('type' in message)
    || message.type !== 'dsh-web-ready' || !('port' in message)) return undefined
  const port = message.port
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

/**
 * Run one public dsh invocation under its owning Web supervisor.
 * Only an explicit child restart request replaces it; crashes and Ctrl+C never restart it.
 * @returns Exit status of the last child, or 130 after a user interrupt.
 */
export async function superviseWeb(): Promise<number> {
  const entry = process.argv[1]
  if (entry === undefined) throw new Error('dsh web: missing launcher entry')
  let child: ChildProcess | undefined
  const state = { stopping: false, interrupted: false, restart: false }
  const shouldRestart = (): boolean => state.restart && !state.stopping
  let port: number | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  const stopChild = (): void => {
    const owned = child
    if (owned === undefined || owned.exitCode !== null || owned.signalCode !== null) return
    if (owned.connected) owned.send({ type: 'dsh-web-shutdown' }, (error) => {
      if (error !== null) owned.kill()
    })
    else owned.kill()
    // 子进程先执行现有的有界清理；父进程只在清理超时后强制结束其拥有的进程。
    deadline ??= setTimeout(() => { owned.kill('SIGKILL') }, PROCESS_SHUTDOWN_TIMEOUT_MS * 2)
    deadline.unref()
  }
  const stop = (signal: NodeJS.Signals): void => {
    state.stopping = true
    state.interrupted = signal === 'SIGINT'
    state.restart = false
    stopChild()
  }
  const sigint = (): void => { stop('SIGINT') }
  const sigterm = (): void => { stop('SIGTERM') }
  process.on('SIGINT', sigint)
  process.on('SIGTERM', sigterm)
  try {
    for (;;) {
      state.restart = false
      const args = [...process.execArgv, entry, ...process.argv.slice(2)]
      if (port !== undefined) args.push('--port', String(port), '--no-open')
      const owned = spawn(process.execPath, args, {
        env: { ...process.env, [WEB_CHILD_ENV]: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      })
      child = owned
      owned.on('message', (message: unknown) => {
        if (state.stopping && typeof message === 'object' && message !== null
          && 'type' in message && message.type === 'dsh-web-listening') stopChild()
        const reported = readyPort(message)
        if (reported !== undefined) port = reported
        if (!state.stopping && port !== undefined && typeof message === 'object' && message !== null
          && 'type' in message && message.type === 'dsh-web-restart' && !state.restart) {
          state.restart = true
          stopChild()
        }
      })
      const code = await new Promise<number>((resolve, reject) => {
        owned.on('error', (error) => {
          if (owned.pid === undefined) reject(error)
          else { state.restart = false; stopChild() }
        })
        owned.once('exit', (code, signal) => { resolve(code ?? (signal === 'SIGINT' ? 130 : 1)) })
      })
      if (deadline !== undefined) { clearTimeout(deadline); deadline = undefined }
      child = undefined
      if (!shouldRestart() || code !== 0) return state.interrupted ? 130 : code
    }
  } finally {
    process.off('SIGINT', sigint)
    process.off('SIGTERM', sigterm)
    if (deadline !== undefined) clearTimeout(deadline)
  }
}
