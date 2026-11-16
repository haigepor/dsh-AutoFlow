/** Composer branch entry and local Git actions, sharing Forge's checkout and changes view. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, Checkbox, IconBranchOutlineRegular, IconChevronDownOutlineRegular, IconInfoOutlineRegular, Input, Menu, MenuItemButton,
  Modal, StateDot, TextArea, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ForgeBranches, ForgeGitStatus, ForgeGitTarget } from '../types.ts'
import type { NS, ForgePanelKey } from './locales.ts'
import type { PanelSnapshot } from './source.ts'
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
  readonly report: (key: ForgePanelKey, params?: Readonly<Record<string, string>>) => void
}

/** Standard Session and locale props plus the entry's own injection. */
export type GitBranchProps = InjectFace<GitBranchInjected> & PropsLocale<typeof NS>
  & Pick<PropsRuntime<'conversation.composer.dock'>, 'useSession' | 'useAccess'>

/**
 * Render the branch entry and portalled Git dialog, hiding it outside a checkout.
 * @param props - Session hooks, Git operations, navigation, and localized copy.
 * @returns the branch entry with its Git dialog.
 */
export function GitBranch({
  usePanel, useSession, useAccess, read, branches, commit, push, switchBranch, generate, viewChanges, report, t,
}: GitBranchProps): ReactNode {
  const checkout = usePanel(snapshot => snapshot.state?.checkout)
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

  if (!known) return null
  const current = status?.root === checkout.checkout.root ? status : null
  const name = current === null ? checkout.checkout.branch ?? checkout.checkout.commit ?? t('checkout.detached')
    : current.branch ?? current.head?.slice(0, 7) ?? t('checkout.detached')
  const blocked = running ? t('git.busy') : current?.blocker === 'read-only' ? t('git.readOnly')
    : current?.blocker === 'outside-writable-root' ? t('git.outside') : null
  const locked = blocked !== null || pending || loading || readError !== null || current === null
  const remote = current === null ? '' : chosenRemote !== null && current.remotes.includes(chosenRemote) ? chosenRemote
    : current.remotes.find(candidate => current.upstream?.startsWith(`${candidate}/`))
      ?? (current.remotes.includes('origin') ? 'origin' : current.remotes[0] ?? '')
  const paths = current?.files.filter(file => selected.has(file.path)).map(file => file.path) ?? []
  const conflicted = current?.files.some(file => file.conflicted) === true
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
  return <>
    <Tooltip label={t('git.entry', { branch: name })} side="top" portal>
      <button type="button" className={css.trigger} aria-haspopup="dialog" aria-expanded={open}
        aria-label={t('git.entry', { branch: name })} data-forge-git="" onClick={() => { setOpen(true); void reload(new AbortController().signal) }}>
        <IconBranchOutlineRegular size={14} /><span className={css.branch}>{name}</span>
        {current !== null && current.files.length > 0 && <span>{current.files.length}</span>}
        <IconChevronDownOutlineRegular size={12} />
      </button>
    </Tooltip>
    <Modal open={open} title={t('git.title')} closeLabel={t('review.close')} onClose={close}
      className={clsx(css.dialog)} contentClassName={clsx(css.content)}>
      <div className={css.body} data-forge-git-panel="" aria-busy={pending || loading}>
        <div className={css.toolbar}>
          <Menu open={branchMenu} portal dense onClose={() => { setBranchMenu(false) }} listClassName={css.menu} anchor={(
            <Tooltip label={switchReason ?? t('git.switch')} portal side="bottom">
              <button type="button" className={css.branchPicker} disabled={locked || !canSwitch || switchReason !== null}
                aria-label={t('git.switch')} aria-haspopup="menu" aria-expanded={branchMenu} onClick={() => { setBranchMenu(value => !value) }}>
                <IconBranchOutlineRegular size={14} />
                <span className={css.branch}>{current?.branch ?? name}</span><IconChevronDownOutlineRegular size={12} />
              </button>
            </Tooltip>
          )}>
            <div className={css.search}><Input aria-label={t('git.search')} placeholder={t('git.search')} value={query}
              onChange={(event) => { setQuery(event.target.value) }} /></div>
            {branchList === null ? <div className={css.hint}><StateDot state="ongoing" /></div>
              : !branchList.ok ? <div className={css.hint} role="alert">{t('toast.branchesFailed')}</div>
                : branchList.value.branches.filter(branch => branch.toLowerCase().includes(query.trim().toLowerCase())).map(branch => (
                  <MenuItemButton key={branch} current={branch === current?.branch} onSelect={() => { pickBranch(branch) }}>
                    {branch}
                  </MenuItemButton>
                ))}
          </Menu>
          <Button size="sm" variant="outline" disabled={pending || loading} onClick={() => { void reload(new AbortController().signal) }}>{t('refresh')}</Button>
          <Button size="sm" variant="outline" onClick={() => { close(); viewChanges() }}>{t('git.changes')}</Button>
        </div>
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
        {current !== null && <>
          <div className={css.toolbar}>
            <span>{current.files.length === 0 ? t('git.clean') : t('git.files', { count: current.files.length })}</span>
            {current.files.length > 0 && <Checkbox label={t('git.selectAll')} disabled={pending} checked={paths.length === current.files.length}
              onChange={(checked) => { setSelected(new Set(checked ? current.files.map(file => file.path) : [])) }} />}
          </div>
          {current.files.length > 0 && <div className={css.files}>{current.files.map(file => (
            <div key={file.path} className={css.file}>
              <Checkbox className={css.fileCheck} label={file.originalPath === null ? file.path : `${file.originalPath} → ${file.path}`}
                checked={selected.has(file.path)} disabled={pending} onChange={(checked) => {
                  setSelected((value) => {
                    const next = new Set(value)
                    if (checked) next.add(file.path)
                    else next.delete(file.path)
                    return next
                  })
                }} />
              <code className={file.conflicted ? css.error : css.fileStatus}>{file.index}{file.worktree}</code>
            </div>
          ))}</div>}
          {conflicted && <p className={css.error} role="status">{t('git.conflict')}</p>}
          <div className={css.messageHeading}>
            <label htmlFor={messageId}>{t('git.message')}</label>
            <Tooltip label={`${t('git.generateHint')}\n${t('git.selectionHint')}`} portal side="top" openOnClick>
              <button type="button" className={css.info} aria-label={t('git.info')}><IconInfoOutlineRegular size={14} /></button>
            </Tooltip>
            <Button size="sm" variant="outline" disabled={pending || running || loading || readError !== null || !canGenerate || paths.length === 0}
              onClick={() => { void run(async () => {
                const result = await generate(current, paths)
                if (result.ok) setMessage(result.value)
                else setError(t('git.generateFailed', { message: result.error.message }))
              }, 'generate') }}>{t(operation === 'generate' ? 'git.generating' : 'git.generate')}</Button>
          </div>
          <TextArea id={messageId} className={css.message} value={message} rows={5} disabled={pending}
            placeholder={t('git.messagePlaceholder')} onChange={(event) => { setMessage(event.target.value) }} />
          <div className={css.toolbar}>
            <Menu open={remoteMenu} portal dense onClose={() => { setRemoteMenu(false) }} anchor={(
              <Button size="sm" variant="outline" disabled={pending || current.remotes.length === 0} aria-haspopup="menu" aria-expanded={remoteMenu}
                onClick={() => { setRemoteMenu(value => !value) }}>{remote === '' ? t('git.noRemote') : t('git.remote', { remote })}</Button>
            )}>{current.remotes.map(candidate => <MenuItemButton key={candidate} current={remote === candidate}
                onSelect={() => { setChosenRemote(candidate); setRemoteMenu(false) }}>{candidate}</MenuItemButton>)}</Menu>
            <Button size="sm" variant="outline" disabled={!pushable} onClick={() => { void run(async () => {
              const result = await push(current, remote)
              if (result.ok) report('git.pushed'); else setError(t('git.failed', { message: result.error.message }))
            }) }}>{t('git.push')}</Button>
          </div>
          <div className={css.actions}>
            {pending && <StateDot state="ongoing" />}
            <Button size="sm" variant="outline" disabled={!committable} onClick={() => { commitSelected(false) }}>{t('git.commit')}</Button>
            <Button size="sm" disabled={!committable || !canPush || remote === '' || current.branch === null}
              onClick={() => { commitSelected(true) }}>{t('git.commitPush')}</Button>
          </div>
        </>}
      </div>
    </Modal>
  </>
}
