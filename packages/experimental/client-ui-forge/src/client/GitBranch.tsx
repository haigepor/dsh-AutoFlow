/** Composer branch entry and local Git actions, sharing Forge's checkout and changes view. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, Checkbox, IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular,
  IconInfoOutlineRegular, IconSearchOutlineRegular, IconSparkleRegular, IconUploadOutlineRegular, IconWorkspaceTreeOutlineRegular,
  Input, Menu, MenuItemButton,
  Modal, StateDot, TextArea, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ForgeBranches, ForgeGitStatus, ForgeGitTarget } from '../types.ts'
import type { NS, ForgePanelKey } from './locales.ts'
import type { PanelSnapshot } from './source.ts'
import { WorktreeToggle, type WorktreeToggleInjected } from './WorktreeToggle.tsx'
import { RefreshGlyph } from './RefreshGlyph.tsx'
import css from './GitBranch.module.css'

/** Local Git operations bound to the entry's Session. */
export interface GitBranchInjected {
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot> }
  readonly read: (signal: AbortSignal) => Promise<RemoteResult<ForgeGitStatus>>
  readonly branches: (signal: AbortSignal) => Promise<RemoteResult<ForgeBranches>>
  readonly commit: (target: ForgeGitTarget, paths: readonly string[], message: string) => Promise<RemoteResult<void>>
  readonly push: (target: ForgeGitTarget, remote: string) => Promise<RemoteResult<void>>
  readonly switchBranch: (target: ForgeGitTarget, branch: string) => Promise<RemoteResult<void>>
  readonly generate: (target: ForgeGitTarget, paths: readonly string[]) => Promise<RemoteResult<string>>
  readonly viewChanges: () => void
  /** Open Forge's checkout status and refresh controls. */
  readonly viewCheckout: () => void
  /** New Session worktree actions, using the same checkout snapshot. */
  readonly worktree: Omit<WorktreeToggleInjected, 'hooks'>
  readonly report: (key: ForgePanelKey, params?: Readonly<Record<string, string>>) => void
}

/** Standard Session and locale props plus the entry's own injection. */
export type GitBranchProps = InjectFace<GitBranchInjected> & PropsLocale<typeof NS>
  & Pick<PropsRuntime<'conversation.composer.dock'>, 'useSession' | 'useAccess'>

/**
 * Render the branch entry and Git dialog, or a checkout inspection failure entry.
 * @param props - Session hooks, Git operations, navigation, and localized copy.
 * @returns the branch entry with its Git dialog.
 */
export function GitBranch({
  usePanel, useSession, useAccess, read, branches, commit, push, switchBranch, generate, viewChanges, viewCheckout, worktree, report, t,
}: GitBranchProps): ReactNode {
  const checkout = usePanel(snapshot => snapshot.state?.checkout)
  const worktreeRequest = usePanel(snapshot => snapshot.state?.worktree.request)
  const running = useSession(session => session.running)
  const canCommit = useAccess('forgePanel/gitCommit')
  const canPush = useAccess('forgePanel/gitPush')
  const canSwitch = useAccess('forgePanel/gitSwitch')
  const canGenerate = useAccess('forgePanel/gitMessage')
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<ForgeGitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [operation, setOperation] = useState<'write' | 'generate' | null>(null)
  const pending = operation !== null
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [message, setMessage] = useState('')
  const [chosenRemote, setChosenRemote] = useState<string | null>(null)
  const [branchMenu, setBranchMenu] = useState(false)
  const [remoteMenu, setRemoteMenu] = useState(false)
  const [branchList, setBranchList] = useState<RemoteResult<ForgeBranches> | null>(null)
  const [query, setQuery] = useState('')
  const messageId = useId()
  const filesTitleId = useId()
  const known = checkout?.state === 'ready'
  const readRevision = useRef(0)
  const reload = useCallback(async (signal: AbortSignal) => {
    const revision = ++readRevision.current
    setLoading(true)
    try {
      const result = await read(signal)
      if (signal.aborted || revision !== readRevision.current) return undefined
      if (result.ok) {
        setStatus(result.value)
        setSelected(current => new Set([...current].filter(path => result.value.files.some(file => file.path === path))))
        setReadError(null)
      } else setReadError(result.error.message)
      return result
    } catch (failure) {
      if (!signal.aborted && revision === readRevision.current) setReadError(failure instanceof Error ? failure.message : String(failure))
      return undefined
    } finally {
      if (!signal.aborted && revision === readRevision.current) setLoading(false)
    }
  }, [read])
  useEffect(() => {
    if (!known) { setStatus(null); setOpen(false); return }
    const control = new AbortController()
    void reload(control.signal)
    const focused = (): void => { void reload(control.signal) }
    window.addEventListener('focus', focused)
    return () => { control.abort(); window.removeEventListener('focus', focused) }
  }, [checkout, known, reload])
  useEffect(() => {
    if (!branchMenu) return
    const control = new AbortController()
    setBranchList(null)
    void branches(control.signal).then((result) => { if (!control.signal.aborted) setBranchList(result) })
    return () => { control.abort() }
  }, [branchMenu, branches])

  if (checkout?.state === 'failed') return <Tooltip label={checkout.message} side="top" portal>
    <button type="button" className={css.trigger} aria-label={t('checkout.failed')} data-forge-git="" onClick={viewCheckout}>
      <IconInfoOutlineRegular size={14} /><span className={css.branch}>{t('checkout.failed')}</span>
    </button>
  </Tooltip>
  if (!known) return null
  const current = status?.root === checkout.checkout.root ? status : null
  const name = current === null ? checkout.checkout.branch ?? checkout.checkout.commit ?? t('checkout.detached')
    : current.branch ?? current.head?.slice(0, 7) ?? t('checkout.detached')
  const entryLabel = t('git.entry', { branch: name })
  const entryTip = worktreeRequest ? `${entryLabel} · ${t('worktree.label')} · ${worktreeRequest.from === null
    ? t('worktree.baseHead') : t('worktree.base', { branch: worktreeRequest.from })}` : entryLabel
  const blocked = running ? t('git.busy') : current?.blocker === 'read-only' ? t('git.readOnly')
    : current?.blocker === 'outside-writable-root' ? t('git.outside') : null
  const locked = blocked !== null || pending || loading || readError !== null || current === null
  const remote = current === null ? '' : chosenRemote !== null && current.remotes.includes(chosenRemote) ? chosenRemote
    : current.remotes.find(candidate => current.upstream?.startsWith(`${candidate}/`))
      ?? (current.remotes.includes('origin') ? 'origin' : current.remotes[0] ?? '')
  const paths = current?.files.filter(file => selected.has(file.path)).map(file => file.path) ?? []
  const conflicted = current?.files.some(file => file.conflicted) === true
  const matchingBranches = branchList?.ok
    ? branchList.value.branches.filter(branch => branch.toLowerCase().includes(query.trim().toLowerCase())) : []
  const pushable = !locked && canPush && remote !== '' && current.branch !== null && current.head !== null
  const committable = !locked && canCommit && !conflicted && paths.length > 0 && message.trim() !== ''
  const switchReason = blocked ?? (current !== null && current.files.length > 0 ? t('git.dirtySwitch') : null)
  const close = (): void => { setOpen(false); setBranchMenu(false); setRemoteMenu(false) }
  const run = async (work: () => Promise<void>, kind: 'write' | 'generate' = 'write'): Promise<void> => {
    if (pending || current === null) return
    setOperation(kind)
    setError(null)
    try { await work() } catch (failure) {
      setError(t(kind === 'generate' ? 'git.generateFailed' : 'git.failed', {
        message: failure instanceof Error ? failure.message : String(failure),
      }))
    } finally {
      await reload(new AbortController().signal)
      setOperation(null)
    }
  }
  const commitSelected = (andPush: boolean): void => {
    if (!committable) return
    void run(async () => {
      const result = await commit(current, paths, message)
      if (!result.ok) { setError(t('git.failed', { message: result.error.message })); return }
      setMessage(''); setSelected(new Set()); report('git.committed')
      if (!andPush) return
      const latest = await read(new AbortController().signal)
      if (!latest.ok) { setError(t('git.committedPushFailed')); return }
      const pushed = await push(latest.value, remote)
      if (!pushed.ok) { setError(`${t('git.committedPushFailed')} ${pushed.error.message}`); return }
      report('git.pushed')
    })
  }
  const pickBranch = (branch: string): void => {
    setBranchMenu(false); setQuery('')
    if (current === null || branch === current.branch || locked || switchReason !== null) return
    void run(async () => {
      const result = await switchBranch(current, branch)
      if (!result.ok) { setError(t('git.failed', { message: result.error.message })); return }
      report('git.switched', { branch })
    })
  }
  const title = t('git.title')
  const hasChanges = current !== null && current.files.length > 0
  return <>
    <Tooltip label={entryTip} side="top" portal>
      <button type="button" className={css.trigger} aria-haspopup="dialog" aria-expanded={open}
        aria-label={entryTip} data-forge-git="" onClick={() => { setOpen(true); void reload(new AbortController().signal) }}>
        {worktreeRequest ? <IconWorkspaceTreeOutlineRegular size={14} /> : <IconBranchOutlineRegular size={14} />}
        <span className={css.branch}>{name}</span>
        {current !== null && current.files.length > 0 && <span>{current.files.length}</span>}
        <IconChevronDownOutlineRegular size={12} />
      </button>
    </Tooltip>
    <Modal open={open} title={title} onClose={close} headless className={clsx(css.dialog, hasChanges && css.withChanges)}>
      <div className={css.body} data-forge-git-panel="" aria-busy={pending || loading}>
        <header className={css.header}>
          <h2>{title}</h2>
          <Button size="sm" className={css.iconAction} aria-label={t('review.close')} icon={<IconCloseOutlineRegular size={16} />}
            onClick={close} />
        </header>
        <div className={css.content}>
          <div className={css.toolbar}>
            <Menu open={branchMenu} portal dense onClose={() => { setBranchMenu(false) }}
              className={css.branchMenu} listClassName={css.menu} anchor={(
                <Tooltip label={switchReason ?? t('git.switch')} portal side="bottom">
                  <button type="button" className={css.branchPicker} disabled={locked || !canSwitch || switchReason !== null}
                    aria-label={t('git.switch')} aria-haspopup="menu" aria-expanded={branchMenu} onClick={() => { setBranchMenu(value => !value) }}>
                    <IconBranchOutlineRegular size={14} />
                    <span className={css.branch}>{current?.branch ?? name}</span><IconChevronDownOutlineRegular size={12} />
                  </button>
                </Tooltip>
              )}>
              <div className={css.search} data-forge-branch-search=""><Input className={clsx(css.searchInput)} icon={<IconSearchOutlineRegular size={14} />}
                aria-label={t('git.search')} placeholder={t('git.search')} value={query}
                onChange={(event) => { setQuery(event.target.value) }} /></div>
              {branchList === null ? <div className={css.hint}><StateDot state="ongoing" /></div>
                : !branchList.ok ? <div className={css.hint} role="alert">{t('toast.branchesFailed')}</div>
                  : matchingBranches.length === 0 ? <p className={css.menuEmpty} role="status">{t('git.noBranches')}</p>
                    : matchingBranches.map(branch => (
                      <MenuItemButton key={branch} current={branch === current?.branch} onSelect={() => { pickBranch(branch) }}>
                        <span className={css.branchOption} data-forge-branch-name="">{branch}</span>
                      </MenuItemButton>
                    ))}
            </Menu>
            <Tooltip label={t('refresh')} portal side="top">
              <Button size="sm" variant="outline" className={css.iconAction} aria-label={t('refresh')} disabled={pending || loading}
                icon={<RefreshGlyph busy={loading} size={14} />} onClick={() => { void reload(new AbortController().signal) }} />
            </Tooltip>
            <Button size="sm" variant="outline" onClick={() => { close(); viewChanges() }}>{t('git.changes')}</Button>
          </div>
          <WorktreeToggle usePanel={usePanel} {...worktree} showCurrentBranch={false} t={t} />
          {current !== null && current.upstream !== null && current.ahead !== null && current.behind !== null && (
            <Tooltip label={t('git.tracking', { upstream: current.upstream, ahead: current.ahead, behind: current.behind })}
              portal side="top" openOnClick>
              <button type="button" className={css.tracking}>{current.upstream} · ↑{current.ahead} ↓{current.behind}</button>
            </Tooltip>
          )}
          {blocked !== null && <p className={css.hint} role="status">{blocked}</p>}
          {readError !== null && <p className={css.error} role="alert">{t('git.statusFailed', { message: readError })}</p>}
          {error !== null && <p className={css.error} role="alert">{error}</p>}
          {current === null && loading && <div className={css.hint} role="status"><StateDot state="ongoing" /></div>}
          {current !== null && (hasChanges ? <div className={css.workbench}>
            <section className={css.changes} aria-labelledby={filesTitleId}>
              <div className={css.sectionBar}>
                <div className={css.counts}>
                  <h3 id={filesTitleId}>{t('git.files', { count: current.files.length })}</h3>
                  <span className={css.hint} aria-live="polite">{t('git.selected', { count: paths.length })}</span>
                </div>
                <Checkbox label={t('git.selectAll')} disabled={pending} checked={paths.length === current.files.length}
                  onChange={(checked) => { setSelected(new Set(checked ? current.files.map(file => file.path) : [])) }} />
              </div>
              <ul className={css.files} role="list" data-forge-git-files="">{current.files.map(file => (
                <li key={file.path} className={css.file} data-selected={selected.has(file.path) || undefined}>
                  <Checkbox className={css.fileCheck} label={file.originalPath === null ? file.path : `${file.originalPath} → ${file.path}`}
                    checked={selected.has(file.path)} disabled={pending} onChange={(checked) => {
                      setSelected((value) => {
                        const next = new Set(value)
                        if (checked) next.add(file.path)
                        else next.delete(file.path)
                        return next
                      })
                    }} />
                  <code className={css.fileStatus}
                    data-change={file.conflicted ? 'conflicted' : file.index === ' ' ? file.worktree : file.index}>{file.index}{file.worktree}</code>
                </li>
              ))}</ul>
              {conflicted && <p className={css.conflict} role="status">{t('git.conflict')}</p>}
            </section>
            <section className={css.commitForm} aria-labelledby={`${messageId}-label`}>
              <div className={css.messageHeading}>
                <label id={`${messageId}-label`} htmlFor={messageId}>{t('git.message')}</label>
                <Tooltip label={`${t('git.generateHint')}\n${t('git.selectionHint')}`} portal side="top" openOnClick>
                  <Button size="sm" className={css.iconAction} aria-label={t('git.info')} icon={<IconInfoOutlineRegular size={14} />} />
                </Tooltip>
              </div>
              <TextArea id={messageId} className={css.message} value={message} rows={4} disabled={pending}
                placeholder={t('git.messagePlaceholder')} onChange={(event) => { setMessage(event.target.value) }} />
              <Button size="sm" variant="outline" className={css.generate} icon={<IconSparkleRegular size={14} />}
                disabled={pending || running || loading || readError !== null || !canGenerate || paths.length === 0}
                onClick={() => { void run(async () => {
                  const result = await generate(current, paths)
                  if (result.ok) setMessage(result.value)
                  else setError(t('git.generateFailed', { message: result.error.message }))
                }, 'generate') }}>{t(operation === 'generate' ? 'git.generating' : 'git.generate')}</Button>
            </section>
          </div> : <div className={css.clean} role="status">
            <IconCheckOutlineRegular size={18} /><span>{t('git.clean')}</span>
          </div>)}
        </div>
        {current !== null && (
          <div className={css.footer}>
            <div className={css.toolbar}>
              {remote === '' ? <span className={css.hint}>{t('git.noRemote')}</span> : <Menu
                open={remoteMenu} portal dense onClose={() => { setRemoteMenu(false) }} anchor={(
                  <Button size="sm" variant="outline" disabled={pending} aria-haspopup="menu" aria-expanded={remoteMenu}
                    onClick={() => { setRemoteMenu(value => !value) }}>{t('git.remote', { remote })}</Button>
                )}>{current.remotes.map(candidate => <MenuItemButton key={candidate} current={remote === candidate}
                  onSelect={() => { setChosenRemote(candidate); setRemoteMenu(false) }}>{candidate}</MenuItemButton>)}</Menu>}
              <Button size="sm" variant="outline" icon={<IconUploadOutlineRegular size={14} />} disabled={!pushable} onClick={() => { void run(async () => {
                const result = await push(current, remote)
                if (result.ok) report('git.pushed'); else setError(t('git.failed', { message: result.error.message }))
              }) }}>{t('git.push')}</Button>
            </div>
            {hasChanges && <div className={css.actions}>
              {pending && <StateDot state="ongoing" />}
              <Button size="sm" variant={remote === '' ? 'primary' : 'outline'} disabled={!committable}
                onClick={() => { commitSelected(false) }}>{t('git.commit')}</Button>
              <Button size="sm" variant="primary" disabled={!committable || !canPush || remote === '' || current.branch === null}
                onClick={() => { commitSelected(true) }}>{t('git.commitPush')}</Button>
            </div>}
          </div>
        )}
      </div>
    </Modal>
  </>
}
