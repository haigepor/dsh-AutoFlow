/** Global feedback survives closing the settings section. */
import { Button, Modal, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { McpFeedbackProps } from './contract.ts'

/** @param props - shared operation state, restart action and locale. @returns transient feedback and explicit restart confirmation. */
export function McpFeedback({ useStore, actions, restartApplication, t }: McpFeedbackProps) {
  const notice = useStore(state => state.notice)
  const open = useStore(state => state.restartConfirm)
  const busy = useStore(state => state.restarting)
  const failed = useStore(state => state.restartFailed)
  const close = (): void => { actions.confirmRestart(false) }
  return <>
    {notice === null ? null : <Toast key={notice.seq} text={t(notice.key)} {...notice.success ? { tone: 'success' as const } : {}} onDone={actions.dismiss} />}
    <Modal open={open} title={t('restartTitle')} description={t('restartDetail')} closeLabel={t('cancel')} onClose={close}
      closeOnBackdropClick={!busy} footer={<><Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => { void restartApplication() }}>{t(busy ? 'restarting' : 'restartConfirm')}</Button></>}>
      {busy ? <div role="status"><StateDot state="ongoing" /> {t('restarting')}</div> : null}
      {failed ? <p role="alert">{t('restartFailed')}</p> : null}
    </Modal>
  </>
}
