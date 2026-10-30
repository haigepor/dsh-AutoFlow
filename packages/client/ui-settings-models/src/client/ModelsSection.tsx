/** Model-first settings with a provider setup page and focused editing dialogs. */

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, IconTrashOutlineRegular, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { LlmNativeAuth, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls this package's SlotMap merge (the two Models child slots).
import type {} from './slot-contract.ts'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import { deriveKeyRef, protocolChoices, reasoningLevelChoices } from './store.ts'
import { modelReasoningOptions } from './model-reasoning.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { ProviderEditor, type ProviderEditorProps } from './ProviderEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'
import { ModelsDirectory, type ModelEditTarget, type ModelsDirectoryTab } from './ModelsDirectory.tsx'
import { ProviderAddNavigation } from './ProviderAddNavigation.tsx'
import { ProviderPicker } from './ProviderPicker.tsx'
import { useProviderPageTransition } from './useProviderPageTransition.ts'
import { ModelEditorDialog } from './ModelEditorDialog.tsx'
import connectStyles from './ProviderConnect.module.css'
import { EditorIntroduction } from './EditorIntroduction.tsx'
import { ProviderBrandIcon } from './ProviderBrandIcon.tsx'
import directoryStyles from './ModelsDirectory.module.css'
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
type ModelsChildSlots = 'settings.models.provider-card' | 'settings.models.footer' | 'settings.models.subscription'

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
  /** The route's catalog endpoint (see {@link ProviderEditorProps.defaultBaseURL}). */
  defaultBaseURL?: string
  /** Environment used to construct an endpoint (see {@link ProviderEditorProps.baseURLEnv}). */
  baseURLEnv?: readonly string[]
  /** The route's native authentication (see {@link ProviderEditorProps.nativeAuth}). */
  nativeAuth?: LlmNativeAuth
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
  modelEdit?: ModelEditTarget | undefined
  hideTitle?: boolean
  pinnedActions?: boolean
  providerDialog?: boolean
  footerAction?: ReactNode
  onBusyChange?: (busy: boolean) => void
  row: ProviderRow
}

/** Render an editor for either the setup posture or an expanded provider row. */
function renderProviderEditor({ target, row, ...props }: ProviderEditorRenderProps): ReactNode {
  return (
    <ProviderEditor
      key={`${target.settingsNs}:${target.provider}:${props.modelEdit?.index ?? 'connection'}`}
      provider={target.provider}
      displayName={target.displayName}
      settingsPath={target.settingsPath}
      {...target.declared === true ? { declared: true } : {}}
      {...target.defaultBaseURL === undefined ? {} : { defaultBaseURL: target.defaultBaseURL }}
      {...target.baseURLEnv === undefined ? {} : { baseURLEnv: target.baseURLEnv }}
      {...target.nativeAuth === undefined ? {} : { nativeAuth: target.nativeAuth }}
      {...row.credential === undefined ? {} : { credential: row.credential }}
      {...row.credentialChecks === undefined ? {} : { credentialChecks: row.credentialChecks }}
      catalogModels={row.catalogModels}
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
    ...row.entry.defaultBaseURL === undefined ? {} : { defaultBaseURL: row.entry.defaultBaseURL },
    ...row.entry.baseURLEnv === undefined ? {} : { baseURLEnv: row.entry.baseURLEnv },
    ...row.entry.nativeAuth === undefined ? {} : { nativeAuth: row.entry.nativeAuth },
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
  /** A new or failed surface waits for a current snapshot; background refreshes preserve its drafts. */
  const [hasReadySnapshot, setHasReadySnapshot] = useState(state.status === 'ready')
  if (state.status === 'ready' && !hasReadySnapshot) setHasReadySnapshot(true)
  const [editing, setEditing] = useState<EditorTarget | undefined>(undefined)
  const [directoryTab, setDirectoryTab] = useState<ModelsDirectoryTab>('models')
  const [modelEdit, setModelEdit] = useState<ModelEditTarget | undefined>(undefined)
  const [providerMenuOpen, setProviderMenuOpen] = useState(false)
  const [addActionsTarget, setAddActionsTarget] = useState<HTMLDivElement | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const subpageRoot = useRef<HTMLDivElement>(null)
  const pageTransition = useProviderPageTransition(subpageRoot)
  const addPageRef = useRef<HTMLElement>(null)
  const addTriggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!addOpen) return
    addPageRef.current?.querySelector<HTMLElement>('[data-provider-heading]')?.focus({ preventScroll: true })
    return () => { addTriggerRef.current?.focus({ preventScroll: true }) }
  }, [addOpen])
  const [addMode, setAddMode] = useState<AddMode>('catalog')
  /** The modes shown since the add card opened; each keeps its panel mounted. */
  const [visited, setVisited] = useState<ReadonlySet<AddMode>>(() => new Set())
  /** Whether each add panel has a write or an interrogation in flight. */
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [customBusy, setCustomBusy] = useState(false)
  /** Base of the add card's tab and panel ids. */
  const addId = useId()
  const [deleteTarget, setDeleteTarget] = useState<(EditorTarget & { reset?: ProviderReset }) | undefined>(undefined)
  const [resetEpoch, setResetEpoch] = useState(0)
  const [editorBusy, setEditorBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)
  const [saveNoticeSeq, setSaveNoticeSeq] = useState(0)
  useEffect(() => { void controller.loadModels() }, [controller])

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
    const close = (): void => {
      setEditing(undefined)
      setModelEdit(undefined)
      setAddOpen(false)
      setProviderMenuOpen(false)
      setCatalogBusy(false)
      setCustomBusy(false)
      setEditorBusy(false)
    }
    if (addOpen) pageTransition.transition(close)
    else close()
  }

  const closeEditor = (changed: boolean, target: ProviderIdentity): void => {
    closeAdd()
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
        // Close only the editor whose provider was removed.
        setEditing(current => current?.provider === removedProvider ? undefined : current)
      })
      .catch((error: unknown) => { setDeleteFailure(error instanceof Error ? error.message : t('resetUnavailable')) })
      .finally(() => { setDeleting(false) })
  }

  const pageHeader = <header className={styles['pageHeader']} data-settings-page-header>
    <div><h1 className={styles['title']}>{t('title')}</h1><p className={styles['intro']}>{t('intro')}</p></div>
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
  if (!hasReadySnapshot && state.status !== 'ready') {
    return (
      <div className={styles['section']}>
        <h2 className={styles['title']}>{t('title')}</h2>
        <p className={styles['intro']}>{t('intro')}</p>
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
  const reasoningLevels = reasoningLevelChoices(piAi, schema)
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
  const switchLocked = catalogBusy || customBusy || editorBusy || deleting || pageTransition.leaving
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
  const selectedProvider = configured.find(row => row.entry.provider === editing?.provider)
  const resetFor = (row: ProviderRow): ProviderReset | undefined => {
    const namespace = state.namespaces.get(row.entry.settingsNs)
    return row.entry.provider === 'deepseek-official' && namespace !== undefined ? providerResetTarget(row, namespace, state.rows) : undefined
  }
  const openDelete = (row: ProviderRow): void => {
    const reset = resetFor(row)
    setDeleteFailure(undefined)
    setDeleteTarget({ ...targetOf(row), ...(reset === undefined ? {} : { reset }) })
  }

  const editorSurface = (<>
    {state.status === 'error' && <div><p role="alert" className={styles['error']}>{state.error}</p>
      <Button variant="outline" onClick={() => { void controller.load() }}>{t('retry')}</Button></div>}
    <section className={`${styles['detail']} ${directoryStyles['editorSurface']}`} data-model-editor={modelEdit !== undefined}
      aria-label={t('providerDetails')}>
      {addOpen ? (
        <div className={connectStyles['layout']}>
          <ProviderAddNavigation id={addId} mode={mode} catalogOffered={catalogOffered} customOffered={customOffered}
            catalogEnabled={catalogEnabled} customEnabled={customEnabled} disabled={switchLocked} t={t}
            onActionsTarget={setAddActionsTarget}
            onChange={(next) => {
              setProviderMenuOpen(false)
              setAddMode(next)
              setVisited(previous => new Set([...previous, next]))
            }} />
          <div className={connectStyles['content']}>
            {mounted('catalog') && draft !== undefined
              ? (
                <div
                  id={`${addId}-catalog-panel`}
                  data-add-mode="catalog"
                  {...bothOffered ? { role: 'tabpanel', 'aria-labelledby': `${addId}-catalog` } : {}}
                  hidden={mode !== 'catalog'}
                  className={`${styles['addPanel']} ${connectStyles['panel']}`}
                >
                  <div className={styles['field']} data-provider-selector>
                    <h3 className={connectStyles['sectionTitle']}>{t('providerSelectService')}</h3>
                    <ProviderPicker
                      open={providerMenuOpen}
                      disabled={catalogBusy}
                      choices={addable.map(({ row }) => ({ id: row.entry.provider, label: row.entry.displayName }))}
                      selected={{ id: draft.target.provider, label: draft.target.displayName }}
                      onOpenChange={setProviderMenuOpen}
                      t={t}
                      onSelect={(id) => {
                        const picked = addable.find(candidate => candidate.row.entry.provider === id)
                        if (picked === undefined) return
                        setEditing(targetOf(picked.row))
                        setProviderMenuOpen(false)
                      }}
                    />
                  </div>
                  <ProviderEditor
                    key={draft.target.provider}
                    provider={draft.target.provider}
                    displayName={draft.target.displayName}
                    hideTitle
                    connecting
                    actionsTarget={mode === 'catalog' ? addActionsTarget : null}
                    submitLabelKey="providerAddSubmit"
                    submitBusyLabelKey="creating"
                    catalogModels={addRow?.catalogModels}
                    namespace={draft.namespace}
                    schema={schema}
                    settingsPath={draft.target.settingsPath}
                    operations={operations}
                    {...draft.target.defaultBaseURL === undefined ? {} : { defaultBaseURL: draft.target.defaultBaseURL }}
                    {...draft.target.baseURLEnv === undefined ? {} : { baseURLEnv: draft.target.baseURLEnv }}
                    {...draft.target.nativeAuth === undefined ? {} : { nativeAuth: draft.target.nativeAuth }}
                    {...addRow?.credentialChecks === undefined ? {} : { credentialChecks: addRow.credentialChecks }}
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
                  data-add-mode="custom"
                  {...bothOffered ? { role: 'tabpanel', 'aria-labelledby': `${addId}-custom` } : {}}
                  hidden={mode !== 'custom'}
                  className={`${styles['addPanel']} ${connectStyles['panel']}`}
                >
                  <CustomProviderCard
                    actionsTarget={mode === 'custom' ? addActionsTarget : null}
                    reasoningOptions={modelReasoningOptions(piAi, schema, ['providers', '_draft'], {})}
                    taken={state.rows.map(row => row.entry.provider)}
                    protocols={protocols}
                    reasoningLevels={reasoningLevels}
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
        </div>
      ) : (() => {
        const selected = selectedProvider
        if (selected === undefined) return <p className={styles['emptyDetail']}>{t('chooseProvider')}</p>
        const target = targetOf(selected)
        const namespace = state.namespaces.get(target.settingsNs)
        if (namespace === undefined) return null
        return (
          <div key={target.provider === 'deepseek-official' ? `${target.provider}:${String(resetEpoch)}` : target.provider}
            className={styles['providerDetail']} data-provider-detail>
            <EditorIntroduction kind={modelEdit === undefined ? 'provider' : 'model'} t={t}
              {...modelEdit === undefined ? {
                icon: <ProviderBrandIcon provider={target.provider} size={22} />,
                ...target.provider === target.displayName ? {} : { help: { title: t('customRoute'), text: target.provider } },
              } : {}}
              title={modelEdit === undefined ? target.displayName : (() => {
                const model = modelEdit.models[modelEdit.index]
                const name = model?.['name'] ?? model?.['id']
                return typeof name === 'string' && name.length > 0 ? name : t('addModel')
              })()}
              description={modelEdit === undefined ? t('providerDirectoryHint')
                : t('modelEditorHint').replace('{provider}', () => target.displayName)} />
            {selected.entry.error === undefined ? null : <p role="alert" className={styles['error']}>{selected.entry.error}</p>}
            {target.provider === 'deepseek-account' ? <p className={styles['advancedHint']}>{t('accountCatalogManaged')}</p> : renderProviderEditor({
              target, row: selected, namespace, schema, operations, t, hideTitle: true, modelEdit,
              providerDialog: modelEdit === undefined,
              footerAction: modelEdit === undefined && (selected.removable || resetFor(selected) !== undefined)
                ? <Button variant="ghost" size="sm" icon={<IconTrashOutlineRegular size={16} />}
                  disabled={switchLocked || !state.writable}
                  aria-label={providerCopy(t(resetFor(selected) === undefined ? 'removeProvider' : 'resetProvider'), target)}
                  onClick={() => { openDelete(selected) }}>{t(resetFor(selected) === undefined ? 'remove' : 'resetConfirm')}</Button>
                : undefined,
              readOnly: !state.writable,
              pinnedActions: true, onBusyChange: setEditorBusy,
              onClose: (changed) => { closeEditor(changed, target) },
            })}
            {renderSlot(
              'settings.models.provider-card',
              { provider: selected.entry, configured: selected.configured, keyConfigured: keyConfiguredOf(selected) },
              { entryKey: selected.entry.settingsNs },
            )}
          </div>
        )
      })()}
    </section>
  </>)

  return (
    <div ref={subpageRoot} className={`${styles['section']} ${addOpen ? connectStyles['setup'] : ''}`} aria-busy={state.status === 'loading'} aria-hidden={!addOpen && editing !== undefined || deleteTarget !== undefined ? true : undefined}>
      <div className={connectStyles['overview']} hidden={addOpen} data-models-subpage data-settings-subpage={pageTransition.active} data-leaving={pageTransition.leaving}>
        <div className={directoryStyles['pageHeading']}>
          {pageHeader}
          {directoryTab !== 'subscription' && (catalogOffered || customOffered) && <Button ref={addTriggerRef} variant="primary" icon={<IconPlusOutlineRegular size={16} />}
            disabled={!state.writable || switchLocked || (!catalogEnabled && !customEnabled)}
            onClick={() => { pageTransition.transition(() => {
              const first = addable[0]
              const initial: AddMode = catalogEnabled ? 'catalog' : 'custom'
              setSavedTarget(undefined); setModelEdit(undefined)
              setEditing(first === undefined ? undefined : targetOf(first.row))
              setAddMode(initial); setVisited(new Set([initial])); setAddOpen(true)
            }) }}>{t('add')}</Button>}
        </div>
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
        <ModelsDirectory state={state} schema={schema} t={t} tab={directoryTab} onTabChange={setDirectoryTab} renderSlot={renderSlot}
          onRetry={() => { void controller.load() }}
          onEdit={(row, model) => {
            if (row.entry.provider === 'autoflow-codex') { setDirectoryTab('subscription'); return }
            setSavedTarget(undefined); setModelEdit(model); setEditing(targetOf(row))
          }}
          onRemove={openDelete}
          removable={(row) => {
            const reset = resetFor(row)
            return row.removable || (reset !== undefined && (reset.fields.length > 0 || reset.credentialRef !== undefined))
          }} />
      </div>
      {addOpen ? <section ref={addPageRef} className={connectStyles['page']} data-provider-page data-models-subpage data-settings-subpage={pageTransition.active} data-leaving={pageTransition.leaving} aria-label={t('add')}>
        {editorSurface}
      </section> : modelEdit !== undefined ? <ModelEditorDialog open={editing !== undefined}
        onClose={() => { if (!switchLocked) closeAdd() }} t={t}>{editorSurface}</ModelEditorDialog>
        : <Modal open={editing !== undefined} onClose={() => { if (!switchLocked) closeAdd() }}
          title={t('providerDetails')}
          closeLabel={t('close')} closeOnBackdropClick={false}
          className={`${directoryStyles['editorDialog']} ${directoryStyles['providerDialog']}`}
          contentClassName={directoryStyles['editorContent'] as string}>
          {editorSurface}
        </Modal>}
      {!addOpen && renderSlot('settings.models.footer', {})}
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
