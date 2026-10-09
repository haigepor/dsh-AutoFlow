/** Saved report totals preserve the difference between failed requests and pixel decisions.
 * @param {object} value Persisted AFP report.
 * @returns {object|null} Safe counters and categories, without provider diagnostic text.
 */
export function afpReportFeedback(value) {
  if (!value?.runId || !Array.isArray(value.categories)) return null
  const categories = value.categories.map(row => ({ ...row,
    pixelReviewed: row.pixelReviewed ?? Math.max(0, row.reviewed - (row.requestFailures ?? 0)),
    rejected: row.rejected ?? Math.max(0, row.reviewed - row.kept - (row.requestFailures ?? 0)),
  }))
  const total = key => categories.reduce((sum, row) => sum + (row[key] ?? 0), 0)
  return { status: value.status, stage: value.stage, categories, pixelReviewed: total('pixelReviewed'), kept: total('kept'),
    rejected: total('rejected'), requestFailures: total('requestFailures'), target: total('target') }
}

/** Subscribe only to an admitted call in an open owning Turn; closure cannot imply job success.
 * @param {object} React Client hooks.
 * @param {object} store Authenticated conversation access.
 * @param {object} props Session and call identity.
 * @param {object} owner Owning Turn and status.
 * @param {string|false} enabled Admitted run identity, or disabled.
 * @returns {object} Matching live facts and connection state.
 */
export function useAfpFeedbackProgress(React, store, props, owner, enabled) {
  const key = JSON.stringify([props.sessionId, owner?.turn, props.callId])
  const [state, setState] = React.useState({ key: '', live: null, disconnected: false })
  React.useEffect(() => {
    if (!enabled || !store || !props.sessionId || owner?.status !== 'open') return
    const controller = new AbortController(); let timer
    const poll = async () => {
      try {
        const rows = await store.conversationData('conversation-progress', { sessionId: props.sessionId, turn: owner.turn, callId: props.callId }, controller.signal)
        if (controller.signal.aborted) return
        const live = rows.find(row => row.callId === props.callId && row.runId === enabled)
        setState(previous => ({ key, live: live ?? (previous.key === key ? previous.live : null),
          disconnected: Boolean(!live && previous.key === key && previous.live) }))
        if (live && ['completed', 'failed', 'stopped'].includes(live.state)) return
      } catch (error) {
        if (controller.signal.aborted) return
        setState(previous => ({ key, live: previous.key === key ? previous.live : null, disconnected: true }))
      }
      timer = setTimeout(poll, store.getSnapshot().status?.pollIntervalMs ?? 2000)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [key, owner?.status, enabled])
  // 历史行只显示保存的事实，不能把最后收到的 running 当成当前状态。
  return state.key === key && owner?.status === 'open' ? state : { live: null, disconnected: false }
}

/** Fixed localized stage labels do not expose internal HTTP or credential details. */
export const feedbackStages = { connection: 'feedbackConnection', collections: 'feedbackDeduplication',
  search: 'feedbackSearch',
  visual: 'feedbackVision', preview: 'feedbackPreview', vision: 'feedbackVision', confirmation: 'feedbackConfirmation',
  completed: 'feedbackAwaitReport', failed: 'agentOperationFailed', stopped: 'agentStopped' }
