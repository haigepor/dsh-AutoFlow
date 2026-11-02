/** The loading view keeps the previous conversation retained until creation succeeds. */
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './OpeningWorkspace.module.css'

/** @param props - localized creation status. @returns a centered native loader without an editable composer. */
export function OpeningWorkspace({ t }: PropsLocale<'workspace'>) {
  return <div className={css.loading} role="status" aria-label={t('actions.newSession')} aria-busy="true" data-workspace-opening>
    <StateDot state="ongoing" size={24} />
  </div>
}
