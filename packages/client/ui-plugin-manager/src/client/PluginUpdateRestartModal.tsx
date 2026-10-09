/** Update completion and explicit restart stay visible outside the Plugins panel. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginManagerFace } from './manager-store.ts'
import { packageText } from './presentation.ts'
import { PluginUpdateActivity } from './PluginUpdateActivity.tsx'

/** Shared completion state and carrier-owned restart action. */
export type PluginUpdateRestartFace = Pick<PluginManagerFace, 'ensure' | 'dismissUpdateRestart' | 'resolveText'> & {
  hooks: Pick<PluginManagerFace['hooks'], 'pluginManager'>
  /** False means native user confirmation was cancelled. */
  restart(signal: AbortSignal): Promise<boolean>
}

/**
 * Show installed versions awaiting restart, with a recoverable failure and a later action.
 * @param props - Shared controller, explicit restart and localized copy.
 * @returns Completion modal, or null when no pending completion is selected.
 */
export function PluginUpdateRestartModal({ usePluginManager, ensure, dismissUpdateRestart, resolveText, restart, t }:
  InjectFace<PluginUpdateRestartFace> & PropsLocale<'pluginManager'>): ReactNode {
  const names = usePluginManager(state => state.updateRestarts ?? [])
  const packages = usePluginManager(state => state.packages)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const lifetime = useRef<AbortController>()
  useEffect(() => { ensure(); return () => { lifetime.current?.abort() } }, [ensure])
  const close = (): void => { if (!busy) { setFailed(false); dismissUpdateRestart() } }
  const apply = async (): Promise<void> => {
    if (busy) return
    setBusy(true); setFailed(false)
    const controller = new AbortController()
    lifetime.current = controller
    try {
      const accepted = await restart(controller.signal)
      if (!accepted && !controller.signal.aborted) setBusy(false)
    } catch (_restartFailed) {
      if (!controller.signal.aborted) { setBusy(false); setFailed(true) }
    }
  }
  return <Modal open={names.length > 0} onClose={close} title={t('updatesRestartTitle')}
    closeLabel={t('close')} description={t('updatesRestartDetail')}
    footer={<><Button variant="outline" disabled={busy} onClick={close}>{t('updatesRestartLater')}</Button>
      <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => { void apply() }}>{t(busy ? 'updatesRestartBusyButton' : 'updatesRestartNow')}</Button></>}>
    <ul>{names.map((name) => {
      const pkg = packages.find(pkg => pkg.name === name)
      const title = pkg === undefined ? name : packageText(pkg, resolveText).title
      return <li key={name}>{pkg?.update?.version === undefined ? title
        : t('updatesRestartPackage', { name: title, version: pkg.update.version })}</li>
    })}</ul>
    {failed ? <p role="alert">{t('updatesRestartFailed')}</p> : null}
    {busy ? <div role="status" aria-live="polite"><PluginUpdateActivity label={t('updatesRestarting')} /></div> : null}
  </Modal>
}
