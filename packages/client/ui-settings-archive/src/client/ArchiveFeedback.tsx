/** Operation notices survive leaving settings or restoring and opening a session. */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArchiveFeedbackProps } from './contract.ts'

/** @param props - shared operation state and localized copy. @returns the current transient notice. */
export function ArchiveFeedback({ useOperation, dismissNotice, t }: ArchiveFeedbackProps) {
  const state = useOperation(value => value)
  const notice = state.notice
  if (notice === null) return null
  const text = t(notice.key, { count: notice.count, success: notice.count, failed: state.result?.failures.length ?? 0 })
  return <Toast key={notice.seq} text={text}
    {...notice.success ? { tone: 'success' as const } : {}} onDone={dismissNotice} />
}
