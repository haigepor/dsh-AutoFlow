/** Stable gallery selection keeps token updates inside the independent analysis view. */
import type { ClientState } from './store.ts'

type AnalysisViewKey = 'analysisRunId' | 'analysisDetail' | 'analysisLoading' | 'analysisError' | 'analysisStreaming' | 'analysisInputs' | 'analysisInputLoading' | 'analysisInputErrors'
/** Gallery state excludes the independently subscribed analysis-dialog payload. */
export type WorkbenchState = Omit<ClientState, AnalysisViewKey>

/** @returns Per-view selector; only gallery/configuration/task-list changes replace its snapshot. */
export function createWorkbenchSelector(): (state: ClientState) => WorkbenchState {
  let previous: WorkbenchState | undefined
  return state => {
    const { analysisRunId: _run, analysisDetail: _detail, analysisLoading: _loading, analysisError: _error, analysisStreaming: _streaming, analysisInputs: _inputs, analysisInputLoading: _inputLoading, analysisInputErrors: _inputErrors, ...view } = state
    if (previous && Object.entries(view).every(([key, value]) => previous![key as keyof WorkbenchState] === value)) return previous
    previous = view
    return view
  }
}
