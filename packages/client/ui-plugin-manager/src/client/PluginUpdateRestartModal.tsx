/** Installed plugin updates apply automatically while their dismissible card reports progress. */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCloseOutlineRegular, IconInfoOutlineRegular, IconRefreshOutlineRegular, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
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
  /** Wait for idle work and apply installed plugins without a second confirmation. */
  restart(signal: AbortSignal, waiting: (value: boolean) => void): Promise<boolean>
}

/**
 * Apply installed versions after work finishes and report progress outside the Plugins panel.
 * @param props - Shared installed facts, carrier-owned automatic restart and localized copy.
 * @returns Completion modal, or null when no pending completion is selected.
 */
export function PluginUpdateRestartModal({ usePluginManager, ensure, dismissUpdateRestart, resolveText, restart, t }:
  InjectFace<PluginUpdateRestartFace> & PropsLocale<'pluginManager'>): ReactNode {
  const names = usePluginManager(state => state.updateRestarts ?? [])
  const packages = usePluginManager(state => state.packages)
  const pending = packages.some(pkg => pkg.update?.restartRequired === true)
  const [phase, setPhase] = useState<'restarting' | 'waiting' | 'failed'>('restarting')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => { ensure() }, [ensure])
  useEffect(() => {
    if (!pending) return
    const controller = new AbortController()
    setPhase('restarting')
    void restart(controller.signal, (waiting) => {
      if (!controller.signal.aborted) setPhase(waiting ? 'waiting' : 'restarting')
    }).then((accepted) => {
      if (!accepted && !controller.signal.aborted) setPhase('failed')
    }, (_restartFailed: unknown) => {
      if (!controller.signal.aborted) setPhase('failed')
    })
    return () => { controller.abort() }
  }, [pending, restart, attempt])
  const busy = phase === 'restarting' && pending
  const failed = phase === 'failed'
  const close = (): void => { if (!busy) dismissUpdateRestart() }
  return <Modal headless open={names.length > 0} onClose={close} title={t('updatesRestartTitle')} className={clsx(css.dialog)}>
    <div className={css.content}>
      <Button variant="ghost" size="sm" className={css.close} aria-label={t('close')} disabled={busy} onClick={close}>
        <IconCloseOutlineRegular size={14} />
      </Button>
      <div className={css.intro}>
        <img className={css.artwork} src={restartArtwork} width={104} height={116} alt="" />
        <div className={css.heading}>
          <Tag tone="success">{t('updatesInstalled')}</Tag>
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
      <div className={css.notice} data-restart-state={failed ? 'failed' : phase}>
        {pending && !failed ? <div role="status" aria-live="polite"><PluginUpdateActivity label={t(phase === 'waiting' ? 'updatesRestartWaiting' : 'updatesRestarting')} />
          {phase === 'waiting' ? <p className={css.hint}>{t('updatesRestartWorkHint')}</p> : null}</div>
          : failed ? <p className={css.error} role="alert">{t('updatesRestartFailed')}</p>
            : <p className={css.hint}><IconInfoOutlineRegular size={16} /><span>{t('updatesRestartWorkHint')}</span></p>}
      </div>
    </div>
    <div className={css.footer}>
      {failed ? <Button variant="primary" icon={<IconRefreshOutlineRegular size={16} />}
        onClick={() => { setAttempt(value => value + 1) }}>{t('updatesRestartRetry')}</Button> : null}
      <Button variant="outline" disabled={busy} onClick={close}>{t('updatesRestartBackground')}</Button>
    </div>
  </Modal>
}
