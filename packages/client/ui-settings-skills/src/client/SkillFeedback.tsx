/** Global operation notice survives leaving skill settings. */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillFeedbackProps } from './contract.ts'
/**
 * @param props - shared operation state and locale.
 * @returns current transient notice.
 */
export function SkillFeedback({ useStore, actions, t }: SkillFeedbackProps) {
  const notice = useStore(state => state.notice)
  return notice === null ? null : (
    <Toast
      key={notice.seq}
      text={t(notice.key)}
      {...(notice.success ? { tone: 'success' as const } : {})}
      onDone={actions.dismiss}
    />
  )
}
