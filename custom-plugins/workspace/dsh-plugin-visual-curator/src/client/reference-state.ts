/** Abort stale collection reads without putting collection-specific status in the global gallery cache. */
import type { ReferenceState } from '../shared/reference-state.ts'

/** @param React Project React runtime. @returns Collection-scoped eligibility hook with explicit retry. */
export function createReferenceStateHook(React: typeof import('react')) {
  return function useReferenceState(read: (styleId: string, signal: AbortSignal) => Promise<ReferenceState>, styleId: string, revision: number, version: string, scope = '', enabled = true) {
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0)
    const [result, setResult] = React.useState<{ identity: string; key: string; plan: ReferenceState | null; error: boolean }>({ identity: '', key: '', plan: null, error: false })
    const identity = JSON.stringify([scope, styleId])
    const key = JSON.stringify([identity, revision, version, attempt])
    React.useEffect(() => {
      if (!enabled) return
      const controller = new AbortController()
      void read(styleId, controller.signal).then(plan => { if (!controller.signal.aborted) setResult({ identity, key, plan, error: false }) }, error => {
        if (!controller.signal.aborted) setResult(current => ({ identity, key, plan: current.identity === identity ? current.plan : null, error: true }))
      })
      return () => controller.abort()
    }, [read, key, enabled])
    // 逐张引入会持续增加修订号；显示保留已确认状态，但选择和分析启动仍只使用最新成功读取。
    return { plan: result.key === key && !result.error ? result.plan : null, displayPlan: result.identity === identity ? result.plan : null, error: result.key === key && result.error, retry }
  }
}
