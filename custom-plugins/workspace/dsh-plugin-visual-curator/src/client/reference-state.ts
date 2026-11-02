/** The collection shares one current eligibility read between badges and analysis-range confirmation. */
import type { ReferenceState } from '../shared/reference-state.ts'

/** @param React Project React runtime. @returns Collection-scoped eligibility hook with explicit retry. */
export function createReferenceStateHook(React: typeof import('react')) {
  return function useReferenceState(read: (styleId: string, signal: AbortSignal) => Promise<ReferenceState>, styleId: string, revision: number, version: string, scope = '', enabled = true) {
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0)
    const [result, setResult] = React.useState<{ identity: string; key: string; plan: ReferenceState | null; error: boolean }>({ identity: '', key: '', plan: null, error: false })
    const identity = JSON.stringify([scope, styleId])
    const key = JSON.stringify([identity, revision, version, attempt])
    const pending = React.useRef<{ key: string; controller: AbortController; promise: Promise<ReferenceState> } | null>(null)
    const beginRead = () => {
      if (pending.current?.key === key && !pending.current.controller.signal.aborted) return pending.current
      pending.current?.controller.abort()
      const controller = new AbortController()
      const promise = read(styleId, controller.signal).then(plan => {
        if (!controller.signal.aborted) setResult({ identity, key, plan, error: false })
        return plan
      }, error => {
        if (pending.current?.controller === controller) pending.current = null
        if (!controller.signal.aborted) setResult(current => ({ identity, key, plan: current.identity === identity ? current.plan : null, error: true }))
        throw error
      })
      pending.current = { key, controller, promise }
      void promise.catch(error => { /* The collection exposes this failure through result.error; explicit callers also receive it. */ })
      return pending.current
    }
    React.useEffect(() => {
      if (enabled) beginRead()
      return () => { if (pending.current?.key === key) { pending.current.controller.abort(); pending.current = null } }
    }, [read, key, enabled])
    const load = async (signal: AbortSignal): Promise<ReferenceState> => {
      signal.throwIfAborted()
      if (result.key === key && result.plan && !result.error) return result.plan
      const work = beginRead().promise
      // 关闭范围弹窗只取消该调用者；页面的同一状态读取仍可完成。
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        void work.then(plan => { signal.removeEventListener('abort', abort); if (!signal.aborted) resolve(plan) }, error => { signal.removeEventListener('abort', abort); reject(error) })
      })
    }
    // 逐张引入会持续增加修订号；显示保留已确认状态，但选择和分析启动仍只使用最新成功读取。
    return { plan: result.key === key && !result.error ? result.plan : null, displayPlan: result.identity === identity ? result.plan : null, error: result.key === key && result.error, retry, load }
  }
}
