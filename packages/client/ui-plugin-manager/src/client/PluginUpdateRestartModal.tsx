/** Update completion and explicit restart stay visible outside the Plugins panel. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCloseOutlineRegular, IconInfoOutlineRegular, IconRefreshOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginManagerFace } from './manager-store.ts'
import { packageText } from './presentation.ts'
import { PluginUpdateActivity } from './PluginUpdateActivity.tsx'
import { PackageArtwork } from './PackageArtwork.tsx'
import restartArtwork from './assets/update-restart-whale-maid-v1.webp'
import css from './PluginUpdateRestartModal.module.css'

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
  return <Modal headless open={names.length > 0} onClose={close} title={t('updatesRestartTitle')} className={clsx(css.dialog)}>
    <div className={css.content}>
      <Button variant="ghost" size="sm" className={css.close} aria-label={t('close')} disabled={busy} onClick={close}>
        <IconCloseOutlineRegular size={14} />
      </Button>
      <div className={css.intro}>
        <img className={css.artwork} src={restartArtwork} width={104} height={116} alt="" />
        <div className={css.heading}>
          <h2 className={css.title}>{t('updatesRestartTitle')}</h2>
          <p className={css.description}>{t('updatesRestartDetail')}</p>
        </div>
      </div>
      <ul className={css.packages} aria-label={t('updatesRestartPackages')}>{names.map((name) => {
        const pkg = packages.find(pkg => pkg.name === name)
        const title = pkg === undefined ? name : packageText(pkg, resolveText).title
        const version = pkg?.update?.version
        return <li className={css.package} key={name} aria-label={version === undefined ? title : t('updatesRestartPackage', { name: title, version })}>
          <span className={css.packageIcon} aria-hidden="true"><PackageArtwork src={pkg?.meta?.icon} size={30} /></span>
          <span className={css.packageName}>{title}</span>
          {version === undefined ? null : <span className={css.version}>{t('versionTag', { version })}</span>}
        </li>
      })}</ul>
      <div className={css.notice} data-restart-state={busy ? 'restarting' : failed ? 'failed' : 'ready'}>
        {busy ? <div role="status" aria-live="polite"><PluginUpdateActivity label={t('updatesRestarting')} /></div>
          : failed ? <p className={css.error} role="alert">{t('updatesRestartFailed')}</p>
            : <p className={css.hint}><IconInfoOutlineRegular size={16} /><span>{t('updatesRestartWorkHint')}</span></p>}
      </div>
    </div>
    <div className={css.footer}>
      <Button variant="outline" disabled={busy} onClick={close}>{t('updatesRestartLater')}</Button>
      <Button variant="primary" disabled={busy} aria-busy={busy} icon={busy ? undefined : <IconRefreshOutlineRegular size={16} />}
        onClick={() => { void apply() }}>{t(busy ? 'updatesRestartBusyButton' : 'updatesRestartNow')}</Button>
    </div>
  </Modal>
}
