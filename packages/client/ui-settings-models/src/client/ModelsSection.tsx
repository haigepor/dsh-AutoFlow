/**
 * Models settings section: the provider rows joined from the configurable
 * directory, settings namespaces, and credential states, with one editor
 * card at a time. Rows retain the account-first order supplied by the store
 * and expose only confirmed API-key state through accessible
 * solid configured or missing dots. A whole-section provider without a
 * configured key renders as its open setup card instead of a row, but only in
 * the first-run posture — no provider on the page can serve requests yet — and
 * only until the user closes that card. The add flow is one card behind one
 * button: a mode switch chooses between adopting a dormant directory provider
 * (the catalog select over the provider editor) and declaring a custom model
 * API (the create form). A panel mounts the first time its mode is shown and
 * stays mounted, hidden, while the card is open and its mode stays offered,
 * so switching modes discards neither draft and an unvisited mode costs
 * nothing; the switch holds still while either panel has a write or an
 * endpoint interrogation in flight, since a switch underneath one would
 * orphan the answer. Each card kind owns its own open state, so closing one
 * never discards a draft in another. Every
 * mutation writes through the wire, while a provider removal first requires
 * confirmation through its rail icon, revealed on hover or focus and always
 * visible on touch devices; the page re-renders from pushed invalidations or the
 * post-apply reload.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, GlideHighlight, IconChevronDownOutlineRegular, IconPanelLeftOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular, Menu, Modal, SegmentedControl, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls this package's SlotMap merge (the two Models child slots).
import type {} from './slot-contract.ts'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import { FieldHelp } from './FieldHelp.tsx'
import { deriveKeyRef, protocolChoices, providerUsable } from './store.ts'
import { modelReasoningOptions } from './model-reasoning.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { ProviderEditor, type ProviderEditorProps } from './ProviderEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'
import { ModelsSkeleton } from './ModelsSkeleton.tsx'
import { providerResetTarget, resetProviderConfiguration } from './provider-reset.ts'
import type { ProviderReset } from './provider-reset.ts'

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: ModelsSettingsStore['store']
  }
  /** The Host operations the section and its cards invoke. */
  operations: ModelsOperations
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * The two ways the add card gains a provider: adopt a directory row the
 * adapter already knows, or declare a route it does not.
 */
type AddMode = 'catalog' | 'custom'

/** The child slots this section declares and dispatches (see ./slot-contract.ts). */
type ModelsChildSlots = 'settings.models.provider-card' | 'settings.models.footer'

/** The child-slot dispatch function the renderer binds for the section. */
type ModelsRenderSlot = PropsRenderSlots<ModelsChildSlots>['renderSlot']

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call) plus the child-slot
 * dispatch seat. The seat is required: the renderer binds it at the render
 * call itself — unlike the inject face it is never absent at runtime — and a
 * direct render that forgets it fails to compile instead of mounting nothing.
 */
export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected>> & PropsRenderSlots<ModelsChildSlots>

type ModelsSectionFace = InjectFace<ModelsSectionInjected>

/** Provider identity shared by row actions and confirmation copy. */
export interface ProviderIdentity {
  /** Stable provider route id. */
  provider: string
  /** Human-facing provider name. */
  displayName: string
}

/** One existing row or dormant directory entry addressed by an editor action. */
interface EditorTarget extends ProviderIdentity {
  settingsNs: string
  settingsPath: readonly string[]
  /** Writable credential identified under this page's conventional reference. */
  credentialRef?: string
  /** The adapter reports this route as one it does not ship (see {@link ProviderEditorProps.declared}). */
  declared?: boolean
}

/** A dormant directory row the add card can adopt, with its registered namespace. */
interface AddableRow {
  row: ProviderRow
  namespace: SettingsNamespaceView
}

/** The catalog draft the add card shows: its editor target and the namespace that takes the write. */
interface CatalogDraft {
  target: EditorTarget
  namespace: SettingsNamespaceView
}

/** Values that vary around the shared provider-editor rendering. */
interface ProviderEditorRenderProps extends Pick<
  ProviderEditorProps,
  'namespace' | 'schema' | 'operations' | 't' | 'readOnly' | 'onClose'
> {
  target: EditorTarget
  hideTitle?: boolean
  pinnedActions?: boolean
  onBusyChange?: (busy: boolean) => void
}

/** Render an editor for either the setup posture or an expanded provider row. */
function renderProviderEditor({ target, ...props }: ProviderEditorRenderProps): ReactNode {
  return (
    <ProviderEditor
      key={`${target.settingsNs}:${target.provider}`}
      provider={target.provider}
      displayName={target.displayName}
      settingsPath={target.settingsPath}
      {...target.declared === true ? { declared: true } : {}}
      {...props}
    />
  )
}

/**
 * Remove one user-added provider and its page-managed credential. Credential
 * removal comes first so a second-step failure leaves the provider row visible
 * and the whole operation safely retryable; both unsets are idempotent.
 * The settings removal names the profile rather than rebuilding its whole
 * namespace from a partial view.
 * @param operations - the page's Host operations.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address and optional managed credential.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function removeProviderProfile(
  operations: ModelsOperations,
  controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: readonly string[]; credentialRef?: string },
): Promise<string | undefined> {
  if (target.credentialRef !== undefined) {
    const credential = await operations.removeCredential(target.credentialRef)
    if (credential !== undefined) return credential
  }
  const written = await operations.writeSettings(
    target.settingsNs,
    [{ op: 'unset', path: [...target.settingsPath] }],
    undefined,
  )
  if (written.kind !== 'written') return written.message
  await controller.load()
  return undefined
}

/**
 * Whether a whole-section provider still needs its first key: an unconfigured
 * credential opens the setup card instead of showing a row. This is the
 * first-run posture alone — a user who can already reach some provider gets an
 * ordinary row with the missing-key dot, since nothing here is blocking them.
 * @param row - the joined provider row.
 * @param anyUsable - whether any joined row can already serve requests.
 * @returns whether to render the setup card.
 */
export function needsSetup(row: ProviderRow, anyUsable: boolean): boolean {
  if (anyUsable || row.entry.provider === 'deepseek-account') return false
  if (row.entry.settingsPath.length > 0) return false
  return row.credential?.configured !== true
}

/**
 * The provider-card seat's credential fact: the reference this page would use
 * for the row — the profile's `apiKeyEnv`, or the page's derived
 * `<ROUTE>_API_KEY` while the profile names none — confirmed configured. The
 * derived half is what keeps the seat consistent with the editor on the
 * add-provider draft, whose dormant row names no reference yet.
 */
function keyConfiguredOf(row: ProviderRow): boolean {
  return row.apiKeyEnv !== undefined
    ? row.credential?.configured === true
    : row.derivedCredential?.configured === true
}

function targetOf(row: ProviderRow): EditorTarget {
  const managedRef = deriveKeyRef(row.entry.provider)
  const credentialRef = row.apiKeyEnv === managedRef
    && row.credential?.configured === true
    && row.credential.writable
    ? managedRef
    : undefined
  return {
    provider: row.entry.provider,
    displayName: row.entry.displayName,
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
    ...credentialRef === undefined ? {} : { credentialRef },
    // Only declared routes may expose route-owned fields.
    ...row.entry.declared === true ? { declared: true } : {},
  }
}

/** Stable visible and accessible identity for one provider target. */
export function providerTargetLabel(target: ProviderIdentity): string {
  return target.provider === target.displayName
    ? target.provider
    : `${target.displayName} (${target.provider})`
}

/** Replace the one provider placeholder in localized destructive-action copy. */
export function providerCopy(template: string, target: ProviderIdentity): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}

/**
 * Render the Models section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, operations, schema, t, renderSlot } = props
  if (
    controller === undefined || useSnapshot === undefined || operations === undefined
    || schema === undefined || t === undefined
  ) return null
  return <Loaded injected={{ controller, useSnapshot, operations, schema, t }} renderSlot={renderSlot} />
}

function Loaded({ injected, renderSlot }: { injected: ModelsSectionFace; renderSlot: ModelsRenderSlot }): ReactNode {
  const { controller, operations, schema, t } = injected
  const snapshot = injected.useSnapshot(value => value)
  const state = { ...snapshot, rows: snapshot.rows.map(row => row.entry.provider === 'deepseek-account'
    ? { ...row, entry: { ...row.entry, displayName: t('deepSeekAccount') } } : row) }
  const [editing, setEditing] = useState<EditorTarget | undefined>(undefined)
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>(undefined)
  const [providerMenuOpen, setProviderMenuOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addMode, setAddMode] = useState<AddMode>('catalog')
  /** The modes shown since the add card opened; each keeps its panel mounted. */
  const [visited, setVisited] = useState<ReadonlySet<AddMode>>(() => new Set())
  /** Whether each add panel has a write or an interrogation in flight. */
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [customBusy, setCustomBusy] = useState(false)
  /** Base of the add card's tab and panel ids. */
  const addId = useId()
  const railId = useId()
  const railBody = useRef<HTMLDivElement>(null)
  const [railCollapsed, setRailCollapsed] = useState(false)
  useLayoutEffect(() => {
    // 缩略入口仍可切换提供商，隐藏的删除操作不接受键盘焦点。
    railBody.current?.querySelectorAll<HTMLElement>('[data-rail-secondary]').forEach((element) => {
      element.inert = railCollapsed
    })
  }, [railCollapsed, snapshot.status])
  const [deleteTarget, setDeleteTarget] = useState<(EditorTarget & { reset?: ProviderReset }) | undefined>(undefined)
  const [resetEpoch, setResetEpoch] = useState(0)
  const [editorBusy, setEditorBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)
  const [saveNoticeSeq, setSaveNoticeSeq] = useState(0)
  const [dismissedSetup, setDismissedSetup] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => { if (snapshot.status === 'idle') void controller.load() }, [controller, snapshot.status])

  const announceSaved = (target: ProviderIdentity): void => {
    // Announced only once the refreshed directory is in the snapshot the
    // notice reads its name from: an apply can rename the route, and the
    // target captured when the card opened still carries the old name.
    void controller.load().then(() => {
      setSavedTarget(target)
      setSaveNoticeSeq(previous => previous + 1)
    })
  }

  /**
   * Close the add card whole. The catalog target is forgotten with it, since
   * `editing` doubles as the row editor's target once the card is closed and a
   * refresh could otherwise open the row of a provider the draft never saved.
   * The busy flags reset here because a panel that closes itself on success
   * unmounts before it can report idle.
   */
  const closeAdd = (): void => {
    setEditing(undefined)
    setAddOpen(false)
    setProviderMenuOpen(false)
    setCatalogBusy(false)
    setCustomBusy(false)
    setEditorBusy(false)
  }

  const closeEditor = (changed: boolean, target: ProviderIdentity): void => {
    if (!addOpen || changed) setSelectedProviderId(target.provider)
    closeAdd()
    if (changed) announceSaved(target)
  }

  /**
   * Close a setup card, which owns none of the state above: the row-editor
   * and add cards each own one of those, so clearing them here would discard
   * a draft the user opened beside this card. Dismissal is this card's own —
   * the provider falls back to an ordinary row for the rest of the session,
   * and reopens through Edit.
   */
  const closeSetup = (changed: boolean, target: ProviderIdentity): void => {
    setEditorBusy(false)
    setSelectedProviderId(target.provider)
    setEditing(undefined)
    setDismissedSetup(previous => new Set([...previous, target.provider]))
    if (changed) announceSaved(target)
  }

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    const removedProvider = deleteTarget.provider
    setDeleting(true)
    setDeleteFailure(undefined)
    const reset = deleteTarget.reset
    void (reset === undefined ? removeProviderProfile(operations, controller, deleteTarget)
      : resetProviderConfiguration(operations, controller, reset, t('resetUnavailable')))
      .then((failure) => {
        if (failure !== undefined) {
          setDeleteFailure(failure)
          return
        }
        setDeleteTarget(undefined)
        if (reset !== undefined) setResetEpoch(value => value + 1)
        // Rail deletion may target another provider; retain that editor's draft.
        setEditing(current => current?.provider === removedProvider ? undefined : current)
        setSelectedProviderId(current => current === removedProvider ? undefined : current)
      })
      .catch((error: unknown) => { setDeleteFailure(error instanceof Error ? error.message : t('resetUnavailable')) })
      .finally(() => { setDeleting(false) })
  }

  const pageHeader = <header className={styles['pageHeader']} data-settings-page-header>
    <h1 className={styles['title']}>{t('title')}</h1>
  </header>
  if ((state.status === 'idle' || state.status === 'loading') && state.namespaces.size === 0) {
    return <div className={styles['section']} aria-busy="true">
      {pageHeader}<span className={styles['srOnly']} role="status">{t('loading')}</span><ModelsSkeleton />
    </div>
  }
  if (state.status === 'error' && state.namespaces.size === 0) {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        {pageHeader}
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  // The saved provider as the directory currently names it. The route id is
  // what the apply cannot change, so it is what the notice is keyed by; a row
  // the same apply removed keeps the captured identity, since nothing newer
  // exists to name it with.
  const savedRow = savedTarget === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === savedTarget.provider)
  const savedIdentity = savedRow === undefined
    ? savedTarget
    : { provider: savedRow.entry.provider, displayName: savedRow.entry.displayName }

  // One fact decides both first-run postures on this page and the onboarding
  // step: whether the user already has a provider to talk to.
  const anyUsable = state.rows.some(providerUsable)
  const configured = state.rows.filter(row => row.configured)
  const configurable = state.rows.filter(row => state.namespaces.has(row.entry.settingsNs))
  const addable: AddableRow[] = state.rows.flatMap((row) => {
    const namespace = state.namespaces.get(row.entry.settingsNs)
    return namespace === undefined || row.configured ? [] : [{ row, namespace }]
  })
  // Hand-declared routes live in the pi-ai namespace, which is also the only
  // one whose schema names the protocols one may speak; without it mounted
  // there is nothing to declare and the mode is not offered.
  const piAi = state.namespaces.get('llm-pi-ai')
  const protocols = protocolChoices(piAi, schema)
  // Each mode is offered while its namespace is mounted and enabled while it
  // has something to offer; the card shows the chosen mode where both are
  // offered, else the only one there is. A mode's panel is mounted while it is
  // the shown mode or has been shown since the card opened — derived, so a
  // refresh that changes which modes are offered can never leave the card
  // without a panel.
  const catalogOffered = configurable.length > 0
  const catalogEnabled = addable.length > 0
  const customOffered = piAi !== undefined
  const customEnabled = protocols.length > 0
  const bothOffered = catalogOffered && customOffered
  const mode: AddMode = bothOffered ? addMode : customOffered ? 'custom' : 'catalog'
  const mounted = (candidate: AddMode): boolean => mode === candidate || visited.has(candidate)
  const switchLocked = catalogBusy || customBusy || editorBusy || deleting
  // The catalog draft: the row the user chose, kept through a refresh that
  // adopts or withdraws it elsewhere so a typed key is never discarded, for as
  // long as its namespace can still take the write; else the first row still
  // addable, since the mode can be entered by a refresh as well as by the
  // switch and the button only picks a target when it opens the card.
  const draft = ((): CatalogDraft | undefined => {
    if (!addOpen || !catalogOffered) return undefined
    const kept = editing === undefined ? undefined : state.namespaces.get(editing.settingsNs)
    if (editing !== undefined && kept !== undefined) return { target: editing, namespace: kept }
    const first = addable[0]
    return first === undefined ? undefined : { target: targetOf(first.row), namespace: first.namespace }
  })()
  // The draft's directory row, for the card extension seat. A refresh can drop
  // the row mid-draft (the route was adopted or withdrawn elsewhere); the
  // draft card stays while the seat simply has no row to dispatch.
  const addRow = draft === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === draft.target.provider)
  const selectedProvider = configured.find(row => row.entry.provider === (editing?.provider ?? selectedProviderId)) ?? configured[0]

  return (
    <div className={styles['section']} aria-busy={state.status === 'loading'}>
      {pageHeader}
      {state.status === 'error' && <div><p role="alert" className={styles['error']}>{state.error}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>{t('retry')}</button></div>}
      {!state.writable && state.status === 'ready' ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {savedIdentity === undefined
        ? null
        : (
          <Toast
            key={saveNoticeSeq}
            text={providerCopy(t('savedProvider'), savedIdentity)}
            tone="success"
            onDone={() => { setSavedTarget(undefined) }}
          />
        )}
      <div className={styles['workspace']} data-rail-collapsed={railCollapsed}>
        <aside className={styles['providerRail']} aria-label={t('providers')}>
          <div className={styles['railHeading']}>
            <span className={styles['railHeadingLabel']}>{t('providers')}</span>
            <Button variant="ghost" size="sm" className={styles['railToggle']}
              aria-label={t(railCollapsed ? 'expandProviders' : 'collapseProviders')}
              title={t(railCollapsed ? 'expandProviders' : 'collapseProviders')}
              aria-expanded={!railCollapsed} aria-controls={railId}
              icon={<IconPanelLeftOutlineRegular size={16} />}
              onClick={() => { setRailCollapsed(value => !value) }} />
          </div>
          <div id={railId} ref={railBody} className={styles['railBody']}>
            <div className={styles['railList']}>
              <GlideHighlight className={styles['railHighlight']} rowSelector="[data-provider-item]" />
              {configured.map((row) => {
                const target = targetOf(row)
                const selected = !addOpen && row.entry.provider === selectedProvider?.entry.provider
                const credentialConfigured = row.credential?.configured === true
                const credentialMissing = !credentialConfigured && row.apiKeyEnv !== undefined && row.credential?.configured === false
                const namespace = state.namespaces.get(target.settingsNs)
                const reset = row.entry.provider === 'deepseek-official' && namespace !== undefined
                  ? providerResetTarget(row, namespace, state.rows) : undefined
                const actionLabel = providerCopy(t(reset === undefined ? 'removeProvider' : 'resetProvider'), target)
                const hasReset = reset !== undefined && (reset.fields.length > 0 || reset.credentialRef !== undefined)
                return (
                  <div
                    key={row.entry.provider}
                    data-provider-item
                    className={styles['railProviderRow']}
                  >
                    <button
                      type="button"
                      data-provider-row
                      className={`${styles['railProvider']} ${selected ? styles['railProviderActive'] : ''}`}
                      aria-label={providerCopy(t('editProvider'), target)}
                      title={railCollapsed ? row.entry.displayName : undefined}
                      aria-current={selected ? 'true' : undefined}
                      disabled={switchLocked}
                      onClick={() => {
                        setSavedTarget(undefined)
                        setAddOpen(false)
                        setSelectedProviderId(row.entry.provider)
                        setEditing(target)
                      }}
                    >
                      <span className={styles['railProviderMark']} aria-hidden="true">{Array.from(row.entry.displayName.trim())[0]?.toLocaleUpperCase()}</span>
                      <span className={styles['railProviderName']} aria-hidden={railCollapsed}>{row.entry.displayName}</span>
                      {credentialConfigured || credentialMissing ? (
                        <span
                          className={`${styles['credentialDot']} ${credentialConfigured ? styles['credentialDotConfigured'] : styles['credentialDotMissing']}`}
                          role="img"
                          aria-label={t(credentialConfigured ? 'credentialConfigured' : 'credentialMissing')}
                          title={t(credentialConfigured ? 'credentialConfigured' : 'credentialMissing')}
                        />
                      ) : null}
                      <span className={styles['railEnd']}>
                        {row.entry.declared === true ? <span className={styles['rowTag']}>{t('customTag')}</span> : null}
                      </span>
                    </button>
                    {row.removable || reset !== undefined ? (
                      <span className={styles['railAction']} data-rail-secondary aria-hidden={railCollapsed}>
                        <Tooltip label={reset !== undefined && !hasReset ? t('resetEmpty') : actionLabel} portal delayMs={300}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className={styles['railRemove']}
                            aria-label={actionLabel}
                            disabled={!state.writable || switchLocked || (reset !== undefined && !hasReset)}
                            icon={<IconTrashOutlineRegular size={14} />}
                            onClick={() => {
                              setSavedTarget(undefined)
                              setDeleteFailure(undefined)
                              setDeleteTarget({ ...target, ...(reset === undefined ? {} : { reset }) })
                            }}
                          />
                        </Tooltip>
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
            {catalogOffered || customOffered ? (
              <button
                type="button"
                aria-label={t('add')}
                title={railCollapsed ? t('add') : undefined}
                className={`${styles['railAdd']} ${addOpen ? styles['railAddActive'] : ''}`}
                disabled={!state.writable || switchLocked || (!catalogEnabled && !customEnabled)}
                onClick={() => {
                  const first = addable[0]
                  const initial: AddMode = catalogEnabled ? 'catalog' : 'custom'
                  setSavedTarget(undefined)
                  setEditing(first === undefined ? undefined : targetOf(first.row))
                  setAddMode(initial)
                  setVisited(new Set([initial]))
                  setAddOpen(true)
                }}
              >
                <IconPlusOutlineRegular size={16} />
                <span className={styles['railAddLabel']} aria-hidden={railCollapsed}>{t('add')}</span>
              </button>
            ) : null}
          </div>
        </aside>
        <section className={styles['detail']} aria-label={t('providerDetails')}>
          {addOpen ? (
            <div className={styles['addCard']}>
              <div className={styles['detailHeading']}>
                <div className={styles['titleWithHelp']}>
                  <h2>{t('add')}</h2>
                  <FieldHelp key={mode} title={t(mode === 'catalog' ? 'addCatalog' : 'addCustom')}
                    text={t(mode === 'catalog' ? 'addCatalogHint' : 'addCustomHint')} t={t} />
                </div>
              </div>
              <div className={styles['addModes']}>
                {bothOffered
                  ? (
                    <SegmentedControl
                      id={addId}
                      label={t('addMode')}
                      value={mode}
                      disabled={switchLocked}
                      options={[
                        {
                          value: 'catalog',
                          label: t('addCatalog'),
                          disabled: !catalogEnabled,
                          ...catalogEnabled ? {} : { title: t('addCatalogExhausted') },
                        },
                        {
                          value: 'custom',
                          label: t('addCustom'),
                          disabled: !customEnabled,
                          ...customEnabled ? {} : { title: t('addCustomUnavailable') },
                        },
                      ]}
                      onChange={(next) => {
                        setProviderMenuOpen(false)
                        setAddMode(next)
                        setVisited(previous => new Set([...previous, next]))
                      }}
                    />
                  )
                  : (
                    // One mode alone has no switch to name it, so the card
                    // carries the mode as its title instead.
                    <div className={styles['editorHeader']}>
                      <span className={styles['editorTitle']}>{t(mode === 'catalog' ? 'addCatalog' : 'addCustom')}</span>
                    </div>
                  )}
              </div>
              {mounted('catalog') && draft !== undefined
                ? (
                  <div
                    id={`${addId}-catalog-panel`}
                    {...bothOffered ? { role: 'tabpanel', 'aria-labelledby': `${addId}-catalog` } : {}}
                    hidden={mode !== 'catalog'}
                    className={styles['addPanel']}
                  >
                    <div className={styles['field']}>
                      <span className={styles['fieldLabel']}>{t('provider')}</span>
                      <Menu
                        open={providerMenuOpen}
                        portal
                        autoFocus
                        className={styles['catalogPicker']}
                        listClassName={styles['catalogMenu']}
                        selectedId={draft.target.provider}
                        items={addable.map(({ row }) => ({ id: row.entry.provider, label: row.entry.displayName }))}
                        onClose={() => { setProviderMenuOpen(false) }}
                        onSelect={(id) => {
                          const picked = addable.find(candidate => candidate.row.entry.provider === id)
                          if (picked === undefined) return
                          setEditing(targetOf(picked.row))
                          setProviderMenuOpen(false)
                        }}
                        anchor={(
                          <button
                            type="button"
                            className={styles['catalogTrigger']}
                            aria-label={t('provider')}
                            aria-haspopup="menu"
                            aria-expanded={providerMenuOpen}
                            disabled={catalogBusy}
                            onClick={() => { setProviderMenuOpen(value => !value) }}
                          >
                            <span>{draft.target.displayName}</span>
                            <IconChevronDownOutlineRegular size={16} />
                          </button>
                        )}
                      />
                    </div>
                    <ProviderEditor
                      key={draft.target.provider}
                      provider={draft.target.provider}
                      displayName={draft.target.displayName}
                      hideTitle
                      namespace={draft.namespace}
                      schema={schema}
                      settingsPath={draft.target.settingsPath}
                      operations={operations}
                      t={t}
                      readOnly={!state.writable}
                      onClose={(changed) => { closeEditor(changed, draft.target) }}
                      onBusyChange={setCatalogBusy}
                    />
                    {addRow === undefined
                      ? null
                      : renderSlot(
                        'settings.models.provider-card',
                        { provider: addRow.entry, configured: addRow.configured, keyConfigured: keyConfiguredOf(addRow) },
                        { entryKey: addRow.entry.settingsNs },
                      )}
                  </div>
                )
                : null}
              {mounted('custom') && piAi !== undefined
                ? (
                  <div
                    id={`${addId}-custom-panel`}
                    {...bothOffered ? { role: 'tabpanel', 'aria-labelledby': `${addId}-custom` } : {}}
                    hidden={mode !== 'custom'}
                    className={styles['addPanel']}
                  >
                    <CustomProviderCard
                      reasoningOptions={modelReasoningOptions(piAi, schema, ['providers', '_draft'], {})}
                      taken={state.rows.map(row => row.entry.provider)}
                      protocols={protocols}
                      revision={piAi.revision}
                      operations={operations}
                      t={t}
                      readOnly={!state.writable}
                      onClose={(changed) => {
                        closeAdd()
                        if (changed) void controller.load()
                      }}
                      onBusyChange={setCustomBusy}
                    />
                  </div>
                )
                : null}
            </div>
          ) : (() => {
            const selected = selectedProvider
            if (selected === undefined) return <p className={styles['emptyDetail']}>{t('chooseProvider')}</p>
            const target = targetOf(selected)
            const namespace = state.namespaces.get(target.settingsNs)
            if (namespace === undefined) return null
            const setup = needsSetup(selected, anyUsable) && !dismissedSetup.has(target.provider)
            const showEditor = setup || editing?.provider === target.provider || selectedProviderId === undefined
            return (
              <div key={target.provider === 'deepseek-official' ? `${target.provider}:${String(resetEpoch)}` : target.provider}
                className={styles['providerDetail']} data-provider-detail>
                <div className={styles['detailHeading']}>
                  <div className={styles['titleWithHelp']}>
                    <h2>{target.displayName}</h2>
                    {target.provider !== target.displayName
                      ? <FieldHelp title={t('customRoute')} text={target.provider} t={t} /> : null}
                  </div>
                </div>
                {selected.entry.error === undefined ? null : <p role="alert" className={styles['error']}>{selected.entry.error}</p>}
                {showEditor ? renderProviderEditor({
                  target, namespace, schema, operations, t, hideTitle: true,
                  readOnly: !state.writable,
                  pinnedActions: true, onBusyChange: setEditorBusy,
                  onClose: (changed) => { (setup ? closeSetup : closeEditor)(changed, target) },
                }) : (
                  <div className={styles['detailClosed']}>
                    <p>{t('editProviderHint')}</p>
                    <button type="button" className={styles['secondaryButton']} onClick={() => { setEditing(target) }}>
                      {t('edit')}
                    </button>
                  </div>
                )}
                {renderSlot(
                  'settings.models.provider-card',
                  { provider: selected.entry, configured: selected.configured, keyConfigured: keyConfiguredOf(selected) },
                  { entryKey: selected.entry.settingsNs },
                )}
              </div>
            )
          })()}
        </section>
      </div>
      {renderSlot('settings.models.footer', {})}
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={deleteTarget === undefined ? '' : providerCopy(t(deleteTarget.reset === undefined ? 'deleteTitle' : 'resetTitle'), deleteTarget)}
        closeLabel={t('close')}
        description={deleteTarget === undefined
          ? ''
          : providerCopy(
            deleteTarget.reset !== undefined ? t('resetDescription') : deleteTarget.credentialRef === undefined
              ? t('deleteDescription')
              : t('deleteDescriptionWithCredential'),
            deleteTarget,
          )}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" data-modal-autofocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles['deleteConfirm']}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined
                ? ''
                : providerCopy(t(deleteTarget.reset !== undefined ? (deleting ? 'resetting' : 'resetConfirm')
                  : (deleting ? 'deleting' : 'deleteConfirm')), deleteTarget)}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}
