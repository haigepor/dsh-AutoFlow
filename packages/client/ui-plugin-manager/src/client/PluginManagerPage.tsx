/**
 * Global plugin management: grouped cards for official configuration and
 * optional bundles, the Installed group's cards for the profile's bundles,
 * their row switches, the install dialog with its guide and folded pnpm
 * output, the uninstall confirmation, and the toasts an action's outcome
 * becomes. A bundle's page lists the rows it contributes as the Host runs
 * them; a plugin's configuration renders on its own page through the slots
 * the page declares.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PackageArtwork } from './PackageArtwork.tsx'
import type { PluginInstallFailureKind, Registry } from '@deepseek-ai/dsh-api-remotes/client'
import type { DshBundleFeatureKind } from '@deepseek-ai/dsh-package-manifest'
import {
  Button, IconCheckCircleFillRegular, IconChevronDownOutlineRegular, IconChevronLeftOutlineMedium,
  IconChevronRightOutlineRegular, IconCloseOutlineMedium, IconCodeOutlineRegular,
  IconInfoOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular,
  IconPanelLeftOutlineRegular, IconSkillOutlineRegular, IconSparkleRegular, IconDownloadOutlineRegular,
  IconWarningOutlineRegular, IconEditOutlineRegular, Input, Menu, MenuItemButton, Modal, pointerModality,
  PluginArtworkDefault, PluginArtworkLoop, PluginArtworkSearch, PluginArtworkSubagent, PluginArtworkTerminal,
  SegmentedTabs, StateDot, Switch, Tag, TerminalBlock, Toast, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer,
  type IconProps, type StateDotState, type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { EXTENSION_BUNDLES, HIDDEN_BUNDLES, MORE_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import type { createNavigationStore } from './navigation-store.ts'
import type { PluginHeaderLayoutFace } from './header-scroll.ts'
import { rowConfigKey, type OfficialItem } from './config-ledger.ts'
import { INSTALL_GIT_EXAMPLE, INSTALL_PATH_EXAMPLE, type PluginManagerLocaleKey } from './locales.ts'
import {
  bundleBusy, asksMirror, featureKey, githubRecoveryRegistry, isInstallPending, offeredRegistries, rowKey, updateCandidate,
  type InstallInputError, type InstallState, type InstallSubject, type PackageRow, type PackageView,
  type PluginManagerFace, type PluginManagerState, type RegistryChoice, type VersionCheck,
} from './manager-store.ts'
import { managementText, noticeText, packageText, registryText, restartText, rowText, type Translate } from './presentation.ts'
import type { PluginPackageRef, PluginRowRef, PluginsSubject } from './slot-contract.ts'
import type { ConfigPageForm } from './slot-contract.ts'
import { UpdateDialog, VersionSection } from './versions.tsx'
import { BundleDetailSection } from './BundleDetailSection.tsx'
import css from './PluginManagerPage.module.css'
import { PluginUpdateActivity } from './PluginUpdateActivity.tsx'
import badgeSkillPreview from './assets/badge-skill-preview.svg'
import badgeSkillPreviewZh from './assets/badge-skill-preview.zh.svg'
import voiceInputPreview from './assets/voice-input-preview.svg'
import voiceInputPreviewZh from './assets/voice-input-preview.zh.svg'

/** Full component props assembled by the main slot renderer. */
export type PluginManagerPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'pluginManager'>
  & PropsRenderSlots<
    | 'plugins.item' | 'plugins.bundle.config' | 'plugins.row.config' | 'plugins.bundle.activation'
    | 'plugins.add.actions' | 'plugins.tab'
    | 'plugins.detail.actions' | 'plugins.detail.badge' | 'plugins.detail.updates' | 'plugins.detail.section'
  >
  & InjectFace<PluginManagerFace & PluginHeaderLayoutFace>
  & PropsStore<ReturnType<typeof createNavigationStore>>

/** The page's slot renderer, narrowed to the configuration slots. */
type RenderConfig = PluginManagerPageProps['renderSlot']
type ResolveText = PluginManagerFace['resolveText']

type RowPhase = NonNullable<PackageRow['phase']>
type BundleFeature = NonNullable<PackageView['features']>[number]

const FEATURE_KIND_KEYS = {
  prompt: 'featureGroupPrompt',
  skill: 'featureGroupSkill',
  script: 'featureGroupScript',
  ui: 'featureGroupUi',
  other: 'featureGroupOther',
} satisfies Record<DshBundleFeatureKind, PluginManagerLocaleKey>

const FEATURE_KIND_ORDER = ['prompt', 'skill', 'script', 'ui', 'other'] as const satisfies readonly DshBundleFeatureKind[]

/** Group typed manifest features, while leaving legacy declarations in their original flat list. */
function featureGroups(features: readonly BundleFeature[]): readonly {
  readonly kind?: DshBundleFeatureKind
  readonly features: readonly BundleFeature[]
}[] {
  if (!features.some(feature => feature.kind !== undefined)) return [{ features }]
  return FEATURE_KIND_ORDER.map(kind => ({ kind, features: features.filter(feature => (feature.kind ?? 'other') === kind) }))
    .filter(group => group.features.length > 0)
}

/** Category icons make prompts, Skills, executable logic, and page UI distinguishable at a glance. */
function FeatureKindIcon({ kind }: { readonly kind: DshBundleFeatureKind | undefined }): ReactNode {
  switch (kind) {
    case 'prompt': return <IconSparkleRegular size={16} />
    case 'skill': return <IconSkillOutlineRegular size={16} />
    case 'script': return <IconCodeOutlineRegular size={16} />
    case 'ui': return <IconPanelLeftOutlineRegular size={16} />
    case 'other': return <IconInfoOutlineRegular size={16} />
    default: return <PluginArtworkDefault size={16} />
  }
}

/** The primary action installs; the adjacent menu offers every add-plugin path. */
function AddPluginMenu({ t, disabled, openInstall, renderSlot }: {
  readonly t: Translate
  readonly disabled: boolean
  readonly openInstall: () => void
  readonly renderSlot: RenderConfig
}): ReactNode {
  const [open, setOpen] = useState(false)
  const onDismiss = (): void => { setOpen(false) }
  return (
    <span className={css.addGroup} role="group" aria-label={t('addPlugin')}>
      <Tooltip label={t('addPlugin')} side="bottom" delayMs={500} focusDelayMs={500} portal disabled={disabled}>
        <Button variant="primary" size="sm" className={css.addPrimary} icon={<IconPlusOutlineRegular size={13} />}
          aria-label={t('addPlugin')} disabled={disabled} onClick={() => { onDismiss(); openInstall() }}>
          <span className={css.toolbarLabel}>{t('addPlugin')}</span>
        </Button>
      </Tooltip>
      <Menu open={open} onClose={onDismiss} align="end" portal autoFocus listClassName={css.addMenu}
        anchor={(
          <Button variant="primary" size="sm" className={css.addMore}
            disabled={disabled} aria-label={t('chooseAddMethod')} aria-haspopup="menu" aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
            onKeyDown={(event) => {
              if (!open && event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) }
            }}>
            <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
          </Button>
        )}>
        <MenuItemButton icon={<IconDownloadOutlineRegular size={14} />} onSelect={() => { onDismiss(); openInstall() }}>
          <span className={css.addMenuItem}>
            <span>{t('installExisting')}</span>
            <span className={css.addMenuDescription}>{t('installExistingDescription')}</span>
          </span>
        </MenuItemButton>
        {renderSlot('plugins.add.actions', { onDismiss })}
      </Menu>
    </span>
  )
}

/** Feature previews of official bundles, shown on their detail pages and selected by UI language. */
const BUNDLE_PREVIEWS = new Map<string, Readonly<Record<'en' | 'zh', string>>>([
  ['@deepseek-ai/dsh-experimental-badge-skill-bundle', { en: badgeSkillPreview, zh: badgeSkillPreviewZh }],
  ['@deepseek-ai/dsh-experimental-voice-input-bundle', { en: voiceInputPreview, zh: voiceInputPreviewZh }],
])

/** How long the list marks a package an install just enabled. */
const HIGHLIGHT_MS = 2_400

/**
 * Whether any plugin row this bundle's patch declares is running.
 *
 * A default-hidden bundle's rows may run without the profile selecting it, for example through
 * `cordis.patch.yml`; that run state is the effective enablement the lists offer.
 * @param pkg - the bundle as the Host reports it.
 * @returns whether at least one declared row runs.
 */
function rowsRunning(pkg: PackageView): boolean {
  return pkg.rows.some(row => row.enabled)
}

/**
 * Whether the main list shows an official optional bundle: any bundle outside `MORE_BUNDLES`, and any held-back one the profile enabled.
 * @param pkg - the official bundle as the Host reports it.
 * @returns whether the main list shows it.
 */
function pinnedToMainList(pkg: PackageView): boolean {
  return !MORE_BUNDLES.includes(pkg.name) || pkg.enabled
}

/**
 * Where an optional bundle sits on both lists: the `EXTENSION_BUNDLES` in their order, then the bundles neither list
 * ranks, then the held-back ones in theirs, so Codex and Claude Code stay last on the More list.
 * @param name - the bundle's package name.
 * @returns the rank; bundles of equal rank keep the order the Host reported.
 */
function optionalBundleRank(name: string): number {
  const ranked = EXTENSION_BUNDLES.indexOf(name)
  if (ranked >= 0) return ranked
  const heldBack = MORE_BUNDLES.indexOf(name)
  return heldBack < 0 ? EXTENSION_BUNDLES.length : EXTENSION_BUNDLES.length + 1 + heldBack
}

/**
 * Order the official optional bundles as both lists show them, so a bundle the profile picks from the More list
 * keeps its place among the neighbours the main list already holds.
 * @param packages - the official bundles the Host offers.
 * @returns the bundles in display order.
 */
function orderOptionalBundles(packages: readonly PackageView[]): PackageView[] {
  return [...packages].sort((a, b) => optionalBundleRank(a.name) - optionalBundleRank(b.name))
}

/** How long a toast holds: long enough to read a failure that names what broke. */
function toastHoldMs(text: string): number {
  return Math.min(8_000, Math.max(3_000, text.length * 80))
}

const PHASE_KEYS = {
  pending: 'rowPhasePending',
  loading: 'rowPhaseLoading',
  active: 'rowPhaseActive',
  failed: 'rowPhaseFailed',
  unloading: 'rowPhaseUnloading',
} satisfies Record<RowPhase, PluginManagerLocaleKey>

/** Status dot naming a root-fiber phase; loading and unloading are live transitions. */
const PHASE_STATES = {
  pending: 'idle',
  loading: 'ongoing',
  active: 'done',
  failed: 'error',
  unloading: 'ongoing',
} satisfies Record<RowPhase, StateDotState>

/** The count line over a pack's components: the total, then only the states that occur. */
function partsSummary(rows: readonly PackageRow[], t: Translate): string {
  const failed = rows.filter(row => row.phase === 'failed').length
  const off = rows.filter(row => !row.enabled).length
  const running = rows.filter(row => row.enabled && row.phase === 'active').length
  return [
    t('partsCountTotal', { count: String(rows.length) }),
    ...running > 0 ? [t('partsCountRunning', { count: String(running) })] : [],
    ...off > 0 ? [t('partsCountOff', { count: String(off) })] : [],
    ...failed > 0 ? [t('partsCountFailed', { count: String(failed) })] : [],
  ].join(' · ')
}

/** Switching for a pack's rows: which rows have a write in flight, and the write. */
interface RowToggles {
  readonly busy: (row: PackageRow) => boolean
  readonly onSetEnabled: (row: PackageRow, enabled: boolean) => void
}

/** Configuration availability for a pack's rows. */
interface RowConfigure {
  readonly has: (row: PackageRow) => boolean
  readonly open: (row: PackageRow) => void
}

/** Rows beyond this count get a filter box above the list. */
const ROW_FILTER_THRESHOLD = 10

/** The size the 36-viewBox plugin artwork renders at inside a card's 48px frame. */
const CARD_ARTWORK_SIZE = 36

/** The artwork of the official plugins that registered their configuration, by registration id. */
const ITEM_ARTWORK = new Map<string, (props: IconProps) => ReactNode>([
  ['shell', PluginArtworkTerminal],
  ['agent-loop', PluginArtworkLoop],
  ['subagent', PluginArtworkSubagent],
  ['web-search', PluginArtworkSearch],
])

/** An official plugin's card and page artwork; plugins without their own get the default. */
function itemArtwork(id: string): ReactNode {
  const Artwork = ITEM_ARTWORK.get(id) ?? PluginArtworkDefault
  return <Artwork size={CARD_ARTWORK_SIZE} />
}

/** A bundle's feature preview; a failed decode is reported in place without blocking management. */
function PackagePreview({ src, title, t }: { readonly src: string; readonly title: string; readonly t: Translate }): ReactNode {
  const [failedSource, setFailedSource] = useState<string>()
  return src === failedSource
    ? <p className={css.reason} role="status">{t('previewUnavailable')}</p>
    : <img className={css.packagePreview} src={src} alt={t('previewAlt', { name: title })} onError={() => { setFailedSource(src) }} />
}

/** A row's switch: locked, saying why, when the Host refuses to address the row through the profile patch. */
function RowSwitch({ row, title, t, busy, target, onChange }: {
  readonly row: PackageRow
  readonly title: string
  readonly t: Translate
  readonly busy: boolean
  readonly target?: boolean | undefined
  readonly onChange: (enabled: boolean) => void
}): ReactNode {
  const locked = row.readOnlyReason !== undefined || row.entryId === undefined
  return (
    <Switch
      checked={target ?? row.enabled}
      loading={busy}
      label={t('partToggle', { name: title })}
      disabled={busy || locked}
      {...row.readOnlyReason === undefined ? {} : { title: managementText({ code: row.readOnlyReason }, t) }}
      onChange={onChange}
    />
  )
}

/** What a row's state line says: off, or the phase its fiber is in. */
function rowStateText(row: PackageRow, t: Translate): string {
  if (!row.enabled) return t('partOff')
  return row.phase === null ? t('rowStateIdle') : t(PHASE_KEYS[row.phase])
}

/** The dot beside a row: its fiber phase, or idle. */
function rowDotState(row: PackageRow): StateDotState {
  if (!row.enabled || row.phase === null) return 'idle'
  return PHASE_STATES[row.phase]
}

/** A Host metadata diagnostic does not change the package's management permissions. */
function MetadataError({ error, t }: { readonly error: string | undefined; readonly t: Translate }): ReactNode {
  return error === undefined ? null : <p className={css.reason} role="status" data-package-meta-error>{t('metadataError', { error })}</p>
}

/** A failed component keeps its current Host diagnostic beside its controls. */
function RuntimeError({ error, t }: { readonly error: string | undefined; readonly t: Translate }): ReactNode {
  return error === undefined ? null : <p className={css.reason} role="status" data-plugin-runtime-error>{t('reasonLabel')}: {error}</p>
}

/**
 * A pack's rows as a list in the order the pack declares them: a state dot,
 * the row id, one line saying its state, and, when the pack is on, a switch. A pack like base
 * carries close to a hundred rows, so a long list gets a filter.
 */
function RowsSection({ rows, t, resolveText, toggle, configure, targets = {} }: {
  readonly rows: readonly PackageRow[]
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly toggle?: RowToggles | undefined
  readonly configure?: RowConfigure | undefined
  readonly targets?: Readonly<Record<string, boolean>>
}): ReactNode {
  const [filter, setFilter] = useState('')
  const query = filter.trim().toLowerCase()
  const localized = rows.map(row => ({ row, ...rowText(row, resolveText) }))
  const shown = query === '' ? localized : localized.filter(({ row, title, description }) =>
    [title, description, row.rowId, row.moduleName].some(value => value?.toLowerCase().includes(query)))
  return (
    <details className={`${css.detailSection} ${css.partsDisclosure}`} data-plugin-rows>
      <summary className={css.sectionHead}>
        <IconChevronRightOutlineRegular className={css.partsChevron} size={14} aria-hidden="true" />
        <span className={css.sectionTitle}>{t('partsLabel')}</span>
        {rows.length === 0 ? null : <span className={css.sectionCount}>{partsSummary(rows, t)}</span>}
      </summary>
      {rows.length === 0 ? <p className={css.status}>{t('partsEmpty')}</p> : null}
      {rows.length > ROW_FILTER_THRESHOLD
        ? (
          <Input
            type="search"
            className={css.partsFilter as string}
            placeholder={t('partsFilter')}
            aria-label={t('partsFilter')}
            value={filter}
            onChange={(event) => { setFilter(event.target.value) }}
          />
        )
        : null}
      {rows.length > 0 && shown.length === 0 ? <p className={css.status}>{t('partsFilterEmpty')}</p> : null}
      {shown.length === 0
        ? null
        : (
          <ul className={css.rows}>
            {shown.map(({ row, title, description }) => (
              <li
                key={row.rowId}
                className={css.row}
                data-plugin-row={row.entryId ?? row.rowId}
                {...row.phase === 'failed' ? { 'data-state': 'failed' } : row.enabled ? {} : { 'data-state': 'off' }}
              >
                <div className={css.rowLine}>
                  <span className={css.rowIcon} aria-hidden="true"><PackageArtwork key={row.meta?.icon} src={row.meta?.icon} row /></span>
                  <div className={css.rowMain}>
                    <span className={css.rowId}>{title}</span>
                    {description === undefined ? null : <span className={css.rowDescription}>{description}</span>}
                    {title === row.rowId && title === row.moduleName
                      ? null
                      : (
                        <span className={css.rowMetadata}>
                          {title === row.rowId ? null : <code className={css.rowModule}>{row.rowId}</code>}
                          {title === row.moduleName ? null : <code className={css.rowModule}>{row.moduleName}</code>}
                        </span>
                      )}
                  </div>
                  <span className={css.rowState}>
                    <StateDot state={rowDotState(row)} />
                    {rowStateText(row, t)}
                  </span>
                  {configure?.has(row) === true ? <Tooltip label={t('configureRow', { name: title })} portal>
                    <Button variant="ghost" size="sm" aria-label={t('configureRow', { name: title })}
                      icon={<IconEditOutlineRegular size={14} />} onClick={() => { configure.open(row) }} />
                  </Tooltip> : null}
                  {toggle === undefined
                    ? null
                    : <RowSwitch
                      row={row} title={title} t={t} busy={toggle.busy(row)}
                      target={row.entryId === undefined ? undefined : targets[rowKey(row.entryId)]}
                      onChange={(enabled) => { toggle.onSetEnabled(row, enabled) }}
                    />}
                </div>
                <MetadataError error={row.meta?.error} t={t} />
                <RuntimeError error={row.diagnostic} t={t} />
              </li>
            ))}
          </ul>
        )}
    </details>
  )
}

/**
 * A bundle's enable switch on its card and its page: locked, saying why, for
 * one the Host protects; off and locked for one it cannot read.
 */
function EnableSwitch({ pkg, title, t, busy, target, onSetEnabled }: {
  readonly pkg: PackageView
  readonly title: string
  readonly t: Translate
  readonly busy: boolean
  readonly target?: boolean | undefined
  readonly onSetEnabled: (enabled: boolean) => void
}): ReactNode {
  return (
    <span className={css.bundleToggle}>
      <span className={css.progressAnnouncement} role="status" aria-live="polite">{busy ? t('applyingChange', { name: title }) : ''}</span>
      <Switch
        checked={target ?? pkg.enabled}
        loading={busy}
        label={t('enableToggle', { name: title })}
        disabled={busy || pkg.readOnlyReason !== undefined || (!pkg.enabled && pkg.error !== undefined && (pkg.error.code === 'unsupported-platform' || !(pkg.availability === 'missing' && pkg.installTarget !== undefined)))}
        {...pkg.readOnlyReason === undefined ? {} : { title: managementText({ code: pkg.readOnlyReason }, t) }}
        onChange={onSetEnabled}
      />
    </span>
  )
}

/** The status one card carries: running, off, or a problem the Host reported. */
function packageStatus(pkg: PackageView): 'running' | 'disabled' | 'problem' {
  if (pkg.error !== undefined || (pkg.enabled && pkg.rows.some(row => row.phase === 'failed'))) return 'problem'
  return pkg.enabled ? 'running' : 'disabled'
}

/** The head every card shares: the artwork, the name that opens the page beside its tags, its one-liner, and what sits at the end. */
function CardHead({ title, t, onOpen, icon, tags, description, end }: {
  readonly title: string
  readonly t: Translate
  readonly onOpen: () => void
  readonly icon: ReactNode
  readonly tags?: ReactNode
  readonly description: ReactNode
  readonly end?: ReactNode
}): ReactNode {
  const descriptionId = useId()
  return (
    <div className={css.cardHead}>
      <span className={css.cardIcon} aria-hidden="true">{icon}</span>
      <div className={css.cardMain}>
        <div className={css.titleRow}>
          <button type="button" className={`${css.cardTitle} ${css.cardOpen}`} aria-label={t('openDetail', { name: title })} aria-describedby={description === undefined ? undefined : descriptionId} onClick={onOpen}>{title}</button>
          {tags}
        </div>
        {description === undefined ? null : <span className={css.cardDesc} id={descriptionId}>{description}</span>}
      </div>
      {end === undefined ? null : <div className={css.cardEnd}>{end}</div>}
    </div>
  )
}

/** First-read placeholders share the core configuration group's card and text-line layout. */
function ListSkeleton({ label }: { readonly label: string }): ReactNode {
  return (
    <section className={css.group} role="status" aria-label={label} data-plugin-loading>
      <div className={css.groupHead} aria-hidden="true">
        <span className={`${css.groupTitle} ${css.skeletonText} ${css.skeletonHeading}`}>
          <span className={`${css.skeletonFill} ${css.skeletonBar}`} />
        </span>
      </div>
      <ul className={css.cards} aria-hidden="true">
        {[0, 1, 2, 3].map(index => (
          <li key={index} className={css.card}>
            <div className={css.cardHead}>
              <span className={`${css.cardIcon} ${css.skeletonFill} ${css.skeletonIcon}`} />
              <div className={css.cardMain}>
                <div className={css.titleRow}>
                  <span className={`${css.cardTitle} ${css.skeletonText} ${css.skeletonTitle}`}>
                    <span className={`${css.skeletonFill} ${css.skeletonBar}`} />
                  </span>
                </div>
                <span className={`${css.cardDesc} ${css.skeletonText} ${css.skeletonDescription}`}>
                  <span className={`${css.skeletonFill} ${css.skeletonBar}`} />
                </span>
              </div>
              <div className={`${css.cardEnd} ${css.skeletonActions}`} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The top every page shares: the crumb and artwork remain in the window drag region. */
function DetailTop({ crumbLabel, crumbText, onBack, icon }: {
  readonly crumbLabel: string
  readonly crumbText: string
  readonly onBack: () => void
  readonly icon: ReactNode
}): ReactNode {
  return (
    <div className={css.detailTop} data-window-drag>
      <button type="button" className={css.crumb} aria-label={crumbLabel} onClick={onBack}>
        <IconChevronLeftOutlineMedium className={css.crumbIcon} size={16} aria-hidden="true" />
        <span>{crumbText}</span>
      </button>
      {icon === null ? null : <div className={css.detailHead}>
        <span className={css.cardIcon} aria-hidden="true">{icon}</span>
      </div>}
    </div>
  )
}

/** Existing identifiers remain available below configuration without crowding the page heading. */
function DetailInformation({ title, entries, folded = false, source = false }: {
  readonly title: string
  readonly folded?: boolean
  readonly source?: boolean
  readonly entries: readonly { readonly label: string; readonly value: ReactNode }[]
}): ReactNode {
  const Container = folded ? 'details' : 'section'
  const heading = <>
    {folded ? <IconChevronRightOutlineRegular className={css.partsChevron} size={14} aria-hidden="true" /> : null}
    <h4 className={css.sectionTitle}>{title}</h4>
  </>
  return (
    <Container className={css.detailInformation} data-plugin-source={source ? '' : undefined}>
      {folded ? <summary className={css.sectionHead}>{heading}</summary> : <div className={css.sectionHead}>{heading}</div>}
      <dl className={css.informationList}>
        {entries.map(({ label, value }) => (
          <div key={label} className={css.informationRow}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Container>
  )
}

/** The registry version a finished version check offers for a package, when it offers one. */
function versionUpdate(check: VersionCheck | undefined): string | undefined {
  return check?.phase === 'done' ? updateCandidate(check.list)?.version : undefined
}

/** The list toolbar's sentence about the last update check of every updatable package. */
function updatesNote(packages: readonly PackageView[], versions: PluginManagerState['versions'], t: Translate): { text: string; tone?: 'info' | 'error' } | undefined {
  const checks = packages.filter(pkg => pkg.updatable).map(pkg => versions[pkg.name])
  if (checks.length === 0 || checks.some(check => check === undefined || check.phase === 'checking')) return undefined
  const available = checks.filter(check => versionUpdate(check) !== undefined).length
  if (available > 0) return { text: t('updatesAvailable', { count: String(available) }), tone: 'info' }
  if (checks.some(check => check?.phase === 'done' && check.list.status === 'refused')) return { text: t('updatesFailed'), tone: 'error' }
  return { text: t('updatesNone') }
}

function updateAvailable(pkg: PackageView): boolean {
  const target = pkg.installTarget
  // An update removes the installed package first, so a package that cannot be removed offers none.
  if (!pkg.installed || !pkg.removable || pkg.availability === 'installation' || target === undefined) return false
  return pkg.version !== target.version
    || ((target.spec.startsWith('link:') || pkg.source?.startsWith('link:') === true) && pkg.source !== target.spec)
}

/** One package as a card that opens its page: its name, its one-liner, its tags, and its bundle switch. */
function PackageCard({ pkg, t, resolveText, busy, target, highlighted, newer, onOpen, onSetEnabled, onUpdate, onRestart }: {
  readonly pkg: PackageView
  /** The newer registry version a version check offers. */
  readonly newer: string | undefined
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly busy: boolean
  readonly target?: boolean | undefined
  readonly highlighted: boolean
  readonly onOpen: () => void
  readonly onSetEnabled: (enabled: boolean) => void
  readonly onUpdate: () => void
  readonly onRestart: () => void
}): ReactNode {
  const { title, description, beta } = packageText(pkg, resolveText)
  const status = packageStatus(pkg)
  return (
    <li
      className={`${css.card} ${css.cardLink}`}
      data-plugin-package={pkg.name}
      data-plugin-status={status}
      {...highlighted ? { 'data-plugin-highlight': '' } : {}}
    >
      <CardHead
        title={title}
        t={t}
        onOpen={onOpen}
        icon={<PackageArtwork key={pkg.meta?.icon} src={pkg.meta?.icon} />}
        tags={(
          <>
            {beta ? <Tag className={css.statusTag} tone="info">{t('statusBeta')}</Tag> : null}
            {status === 'problem' ? <Tag className={css.statusTag} tone="danger">{t('statusProblem')}</Tag> : null}
            {pkg.update?.restartRequired === true
              ? <Button variant="ghost" size="sm" className={css.updateBadge} onClick={onRestart}>
                <Tag tone="info">{t('updatesPending')}</Tag>
              </Button>
              : pkg.update?.status === 'installing' || busy && pkg.update?.status === 'available'
                ? <span className={css.updateBadge} role="status" aria-busy="true"><Tag tone="info"><PluginUpdateActivity compact label={t('updatesInstalling')} /></Tag></span>
                : pkg.update?.status === 'available'
                  ? <Button variant="ghost" size="sm" className={css.updateBadge} disabled={busy} onClick={onUpdate}>
                    <Tag tone="info">{t('updatesBadge', { version: pkg.update.version ?? '' })}</Tag>
                  </Button>
                  : pkg.update?.status === 'error'
                    ? <Tag tone="danger">{t('updatesFailed')}</Tag> : null}
            {pkg.availability === 'missing' ? <Tag className={css.statusTag}>{t(pkg.installed ? 'statusMissingFiles' : 'statusNotInstalled')}</Tag> : null}
            {updateAvailable(pkg) || newer !== undefined ? <Tag className={css.statusTag} tone="info">{t('statusUpdateAvailable')}</Tag> : null}
          </>
        )}
        description={description}
        end={<EnableSwitch pkg={pkg} title={title} t={t}
          busy={busy || pkg.update?.status === 'installing' || pkg.update?.restartRequired === true}
          target={target} onSetEnabled={onSetEnabled} />}
      />
      <MetadataError error={pkg.meta?.error} t={t} />
      {pkg.error?.code === 'unsupported-platform' && <p className={css.reason} role="status">{managementText(pkg.error, t)}</p>}
    </li>
  )
}

/**
 * One official plugin as a card that opens its page: its icon, its title from
 * the registration, and the one-liner the entry renders in its summary view.
 */
function ItemCard({ item, t, onOpen, renderSlot }: {
  readonly item: OfficialItem
  readonly t: Translate
  readonly onOpen: () => void
  readonly renderSlot: RenderConfig
}): ReactNode {
  return (
    <li className={`${css.card} ${css.cardLink}`} data-plugin-item={item.id}>
      <CardHead title={item.label} t={t} onOpen={onOpen} icon={itemArtwork(item.id)} description={renderSlot('plugins.item', { view: 'summary' }, { only: item.id })} />
    </li>
  )
}

/** One row as the detail slots see it. */
function rowRef(row: PackageRow): PluginRowRef {
  return { rowId: row.rowId, moduleName: row.moduleName, enabled: row.enabled }
}

/** One bundle as the detail slots see it. */
function packageRef(pkg: PackageView): PluginPackageRef {
  return {
    name: pkg.name,
    ...pkg.updateManager === undefined ? {} : { updateManager: pkg.updateManager },
    ...pkg.version === undefined ? {} : { version: pkg.version },
    installed: pkg.installed,
    availability: pkg.availability,
    official: pkg.official,
    enabled: pkg.enabled,
    rows: pkg.rows.map(rowRef),
  }
}

/**
 * An official plugin's page: the crumb back to the cards, its icon with the
 * contributed actions, its title with the contributed badges over its
 * one-liner, the form the entry renders, and the contributed sections.
 */
function ItemDetail({ item, t, onBack, renderSlot, form }: {
  readonly item: OfficialItem
  readonly t: Translate
  readonly onBack: () => void
  readonly renderSlot: RenderConfig
  readonly form: ConfigPageForm | undefined
}): ReactNode {
  const subject: PluginsSubject = { kind: 'item', id: item.id }
  return (
    <div className={css.detail} data-plugin-item-detail={item.id}>
      <DetailTop
        crumbLabel={t('backToList')}
        crumbText={t('crumbRoot')}
        onBack={onBack}
        icon={itemArtwork(item.id)}
      />
      <div className={css.detailMain}>
        <div className={css.detailTitleLine}>
          <div className={css.titleRow}>
            <h3 className={css.detailTitle}>{item.label}</h3>
            {renderSlot('plugins.detail.badge', { subject })}
          </div>
          <div className={css.detailActions}>{renderSlot('plugins.detail.actions', { subject })}</div>
        </div>
        <p className={css.detailDesc}>{renderSlot('plugins.item', { view: 'summary' }, { only: item.id })}</p>
      </div>
      <div className={css.detailSections}>
        <section className={css.detailSection} data-plugin-config>
          {renderSlot('plugins.item', { view: 'page', form }, { only: item.id })}
        </section>
        {renderSlot('plugins.detail.section', { subject })}
      </div>
      <DetailInformation title={t('detailInformation')} entries={[{ label: t('detailId'), value: <code>{item.id}</code> }]} />
    </div>
  )
}

/**
 * A row's configuration page keeps its technical identity beside local package
 * text and the form supplied by its configuration entry.
 */
function RowDetail({ pkg, row, t, resolveText, onBack, renderSlot, form }: {
  readonly pkg: PackageView
  readonly row: PackageRow
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly onBack: () => void
  readonly renderSlot: RenderConfig
  readonly form: ConfigPageForm | undefined
}): ReactNode {
  const { title } = packageText(pkg, resolveText)
  const { title: rowTitle, description } = rowText(row, resolveText)
  const key = rowConfigKey(pkg.name, row.rowId)
  const subject: PluginsSubject = { kind: 'row', pkg: packageRef(pkg), row: rowRef(row) }
  return (
    <div className={css.detail} data-plugin-row-detail={key}>
      <DetailTop
        crumbLabel={t('backToPackage', { name: title })}
        crumbText={title}
        onBack={onBack}
        icon={<PackageArtwork key={row.meta?.icon} src={row.meta?.icon} row size={CARD_ARTWORK_SIZE} />}
      />
      <div className={css.detailMain}>
        <div className={css.titleRow}>
          <h3 className={css.detailTitle}>{rowTitle}</h3>
          {renderSlot('plugins.detail.badge', { subject })}
        </div>
        <div className={css.detailActions}>{renderSlot('plugins.detail.actions', { subject })}</div>
        {rowTitle === row.rowId ? null : <p className={css.detailName}><code>{row.rowId}</code></p>}
        <p className={css.detailName}><code>{row.moduleName}</code></p>
        <p className={css.detailDesc}>{description ?? renderSlot('plugins.row.config', { view: 'summary' }, { entryKey: key })}</p>
      </div>
      <MetadataError error={row.meta?.error} t={t} />
      <RuntimeError error={row.diagnostic} t={t} />
      <div className={css.detailSections} data-plugin-config>
        {renderSlot('plugins.row.config', { view: 'page', form }, { entryKey: key })}
        {renderSlot('plugins.detail.section', { subject })}
      </div>
    </div>
  )
}

/** A feature keeps its confirmed runtime badge beside its pending switch value and configuration action. */
function FeatureRow({ feature, row, t, resolveText, busy, checked, locked, configure, onChange }: {
  readonly feature: BundleFeature
  readonly row: PackageRow | undefined
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly busy: boolean
  readonly checked: boolean
  readonly locked: boolean
  readonly configure: (() => void) | undefined
  readonly onChange: (enabled: boolean) => void
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [failedIcon, setFailedIcon] = useState<string>()
  const title = resolveText(feature.title)
  const detailsId = useId()
  const phase = row?.phase
  const statusKey = !feature.enabled ? 'featureOff' : phase === 'failed' ? 'rowPhaseFailed'
    : phase === 'loading' ? 'rowPhaseLoading' : phase === 'unloading' ? 'rowPhaseUnloading'
      : row?.enabled && phase === 'active' ? 'featureRunning' : 'featureSelected'
  const tone = statusKey === 'featureRunning' ? 'success' : statusKey === 'rowPhaseFailed' ? 'danger'
    : statusKey === 'rowPhaseLoading' || statusKey === 'rowPhaseUnloading' ? 'info' : 'neutral'
  return <li className={css.featureItem} {...feature.kind === undefined ? {} : { 'data-feature-kind': feature.kind }}>
    <div className={css.featureLine}>
      <span className={css.featureIcon} aria-hidden="true">{feature.icon === undefined || feature.icon === failedIcon
        ? <FeatureKindIcon kind={feature.kind} />
        : <span className={css.featureArtwork} style={{ maskImage: `url("${feature.icon}")`, WebkitMaskImage: `url("${feature.icon}")` }}>
          {/* Detect failed artwork loads; the category token colors the mask. */}
          <img src={feature.icon} alt="" onError={() => { setFailedIcon(feature.icon) }} />
        </span>}</span>
      <div className={css.featureText}>
        <button type="button" className={css.featureTitle} aria-expanded={expanded} aria-controls={detailsId}
          onClick={() => { setExpanded(!expanded) }}>
          <strong>{title}</strong><IconChevronRightOutlineRegular size={13} aria-hidden="true" />
        </button>
      </div>
      <div className={css.featureActions}>
        <Tag tone={tone}>{t(statusKey)}</Tag>
        {configure === undefined ? null : <Tooltip label={t('configureRow', { name: title })} portal>
          <Button variant="ghost" size="sm" aria-label={t('configureRow', { name: title })}
            icon={<IconEditOutlineRegular size={14} />} onClick={configure} />
        </Tooltip>}
        <Switch checked={checked} loading={busy} disabled={busy || locked}
          label={t('featureToggle', { name: title })} onChange={onChange} />
      </div>
    </div>
    <div id={detailsId} className={css.featureDisclosure} data-expanded={expanded} aria-hidden={!expanded}>
      <div className={css.featureClip}>
        <div className={css.featureDetails}>
          {resolveText(feature.details ?? feature.description).split(/\n\s*\n/u).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        </div>
      </div>
    </div>
  </li>
}

/** Declared release status, explicit update actions and persisted automatic-install permission. */
function UpdatesSection({ pkg, t, busy, checking, onCheck, onUpdate, onAutoUpdate, onRestart }: {
  readonly pkg: PackageView
  readonly t: Translate
  readonly busy: boolean
  readonly checking: boolean
  readonly onCheck: () => void
  readonly onUpdate: () => void
  readonly onAutoUpdate: (enabled: boolean) => void
  readonly onRestart: () => void
}): ReactNode {
  const update = pkg.update
  const [open, setOpen] = useState(update?.status === 'error')
  useEffect(() => { if (update?.status === 'error') setOpen(true) }, [update?.status])
  if (update === undefined) return null
  const installing = update.status === 'installing' || busy && update.status === 'available'
  const active = !update.restartRequired && (installing || checking)
  const status = update.restartRequired ? t('updatesRestart') : installing ? t('updatesInstalling') : checking ? t('updatesChecking')
    : update.status === 'available' ? t('releaseUpdateAvailable', { version: update.version ?? '' })
      : t(update.status === 'current' ? 'updatesCurrent' : update.status === 'error' ? 'updatesError' : 'updatesUnchecked')
  return <details className={`${css.detailSection} ${css.updatesDisclosure}`} open={open}
    onToggle={(event) => { setOpen(event.currentTarget.open) }} data-plugin-updates>
    <summary className={css.updatesHead}>
      <IconChevronRightOutlineRegular size={14} className={css.partsChevron} aria-hidden="true" />
      <span className={css.sectionTitle}>{t('updatesTitle')}</span>
      {pkg.version === undefined ? null : <span className={css.updateVersion}>{t('updatesVersion', { version: pkg.version })}</span>}
      {open ? null : <span className={css.updateSummary} role="status" aria-live="polite" data-error={update.status === 'error'}>
        {active ? <PluginUpdateActivity compact label={status} /> : status}
      </span>}
    </summary>
    <div className={css.updatesBody}>
      <div className={css.updateRelease}>
        {open ? <div className={css.updateStatus} role="status" aria-live="polite" data-error={update.status === 'error'}>
          {active ? <PluginUpdateActivity label={status} /> : status}
        </div> : null}
        <div className={css.updateActions}>
          <Button variant="outline" size="sm" disabled={busy || checking || installing || update.restartRequired} onClick={onCheck}>
            {t(checking ? 'updatesChecking' : 'updatesCheck')}
          </Button>
          {update.restartRequired ? <Button size="sm" onClick={onRestart}>{t('updatesRestartGuide')}</Button>
            : update.status !== 'available' ? null : <Button size="sm" disabled={busy} onClick={onUpdate}>{t('updatesInstall')}</Button>}
        </div>
      </div>
      {update.status !== 'error' || update.diagnostic === undefined ? null : <p className={css.reason}>{update.diagnostic}</p>}
      <div className={css.updatePreference}>
        <div className={css.updatePreferenceText}><span className={css.updatePreferenceTitle}>{t('updatesAutomatic')}</span><p className={css.updateHint}>{t('updatesHint')}</p></div>
        <Switch checked={update.automatic} disabled={busy || installing} label={t('updatesAutomatic')} onChange={onAutoUpdate} />
      </div>
    </div>
  </details>
}

/** Independent bundle switches share one page without coupling their activation or installation. */
function ManagedModules({ packages, t, resolveText, busy, targets, onSetEnabled }: {
  readonly packages: readonly PackageView[]
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly busy: (name: string) => boolean
  readonly targets: Readonly<Record<string, boolean>>
  readonly onSetEnabled: (name: string, enabled: boolean) => void
}): ReactNode {
  return <section className={css.managedModules} data-managed-modules>
    <div className={css.managedSectionHead}><h4>{t('managedModules')}</h4></div>
    {packages.map((module) => {
      const text = packageText(module, resolveText)
      const row = module.rows.find(item => item.enabled) ?? module.rows[0]
      return <div className={css.managedModule} key={module.name} data-managed-module={module.name}>
        <span className={css.rowIcon} aria-hidden="true"><PackageArtwork src={module.meta?.icon} size={24} /></span>
        <div className={css.managedModuleText}><span>{text.title}</span>
          {module.version === undefined ? null : <small>{t('updatesVersion', { version: module.version })}</small>}
        </div>
        <span className={css.rowState}><StateDot state={module.enabled && row !== undefined ? rowDotState(row) : 'idle'} />
          {module.enabled && row !== undefined ? rowStateText(row, t) : t('partOff')}
        </span>
        <EnableSwitch pkg={module} title={text.title} t={t} busy={busy(module.name)} target={targets[module.name]}
          onSetEnabled={(enabled) => { onSetEnabled(module.name, enabled) }} />
      </div>
    })}
  </section>
}

/** A bundle's selectable capabilities, shared configuration, and component inventory. */
function PackageDetail({
  pkg, companion, companionBusy = false, onSetCompanionEnabled,
  t, resolveText, busy, featureBusy, rowBusy, targets, rowForm, configured, configure, renderSlot,
  onBack, onSetEnabled, onUninstall, onOfficialUpdate, onSetRowEnabled, onSetFeature, onOpenExample,
  updateChecking, onCheckUpdates, onUpdate, onAutoUpdate, onRestart, inMore,
  versions, detail, onEnsureVersions, onCheckVersions, onUpdateVersion,
}: {
  readonly pkg: PackageView
  readonly versions: VersionCheck | undefined
  readonly detail: ReactNode
  readonly companion?: PackageView | undefined
  readonly companionBusy?: boolean
  readonly onSetCompanionEnabled?: ((enabled: boolean) => void) | undefined
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly busy: boolean
  /** Whether this exact declared feature is being persisted. */
  readonly featureBusy: (featureId: string) => boolean
  /** Whether a row has a write in flight. */
  readonly rowBusy: (row: PackageRow) => boolean
  readonly targets: Readonly<Record<string, boolean>>
  readonly rowForm: (row: PackageRow) => ConfigPageForm | undefined
  /** Whether the bundle registered a configuration of its own. */
  readonly configured: boolean
  readonly configure: Pick<RowConfigure, 'has'>
  readonly renderSlot: RenderConfig
  readonly inMore: boolean
  readonly onBack: () => void
  readonly onSetEnabled: (enabled: boolean) => void
  readonly onUninstall: () => void
  readonly onOfficialUpdate: () => void
  readonly onSetRowEnabled: (row: PackageRow, enabled: boolean) => void
  readonly onSetFeature: (featureId: string, enabled: boolean) => void
  readonly onOpenExample: (prompt: string) => void
  readonly updateChecking: boolean
  readonly onCheckUpdates: () => void
  readonly onUpdate: () => void
  readonly onAutoUpdate: (enabled: boolean) => void
  readonly onRestart: () => void
  /** Check a package's versions unless a check already started. */
  readonly onEnsureVersions: (packageName: string) => void
  readonly onCheckVersions: () => void
  /** Ask before installing one listed newer version. */
  readonly onUpdateVersion: (version: string) => void
}): ReactNode {
  const [editing, setEditing] = useState<{ rowId: string; featureId?: string } | null>(null)
  const editingRow = pkg.rows.find(row => row.rowId === editing?.rowId)
  const editingFeature = pkg.features?.find(feature => feature.id === editing?.featureId)
  const { title, description, beta } = packageText(pkg, resolveText)
  const previews = BUNDLE_PREVIEWS.get(pkg.name)
  const preview = previews === undefined ? undefined : resolveText(previews)
  const newer = versionUpdate(versions)
  const status = packageStatus(pkg)
  const subject: PluginsSubject = { kind: 'bundle', pkg: packageRef(pkg) }
  return (
    <div className={`${css.detail} ${css.bundleDetail}`} data-plugin-detail={pkg.name}
      {...companion === undefined ? {} : { 'data-managed-bundle': '' }}>
      <DetailTop
        crumbLabel={inMore ? t('backToPackage', { name: t('moreTitle') }) : t('backToList')}
        crumbText={t(inMore ? 'moreTitle' : 'crumbRoot')}
        onBack={onBack}
        icon={companion === undefined ? <PackageArtwork key={pkg.meta?.icon} src={pkg.meta?.icon} /> : null}
      />
      <div className={css.detailMain}>
        <div className={css.detailTitleLine}>
          {companion === undefined ? null : <span className={css.managedBrandIcon} aria-hidden="true">
            <PackageArtwork key={pkg.meta?.icon} src={pkg.meta?.icon} />
          </span>}
          <div className={css.titleRow}>
            <h3 className={css.detailTitle}>{title}</h3>
            {beta ? <Tag className={css.statusTag} tone="info">{t('statusBeta')}</Tag> : null}
            {status === 'problem' ? <Tag className={css.statusTag} tone="danger">{t('statusProblem')}</Tag> : null}
            {renderSlot('plugins.detail.badge', { subject })}
          </div>
          <div className={css.detailActions}>
            {renderSlot('plugins.detail.actions', { subject })}
            {updateAvailable(pkg) ? (
              <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />}
                disabled={busy} aria-label={t('updateLabel', { name: title })} onClick={onOfficialUpdate}>
                {t('update')}
              </Button>
            ) : null}
            {newer === undefined ? null : (
              <Button variant="primary" size="sm" icon={<IconRefreshOutlineRegular size={13} />}
                disabled={busy} aria-label={t('versionsUpdateLabel', { version: newer })} onClick={() => { onUpdateVersion(newer) }}>
                {t('versionsUpdateLabel', { version: newer })}
              </Button>
            )}
            {pkg.removable
              ? (
                <Button
                  variant="outline"
                  size="sm"
                  className={css.danger}
                  icon={<IconTrashOutlineRegular size={13} />}
                  aria-label={t('uninstallLabel', { name: title })}
                  disabled={busy || pkg.readOnlyReason !== undefined}
                  onClick={onUninstall}
                >
                  {t('uninstall')}
                </Button>
              )
              : null}
            {companion === undefined ? <EnableSwitch pkg={pkg} title={title} t={t} busy={busy || pkg.update?.restartRequired === true}
              target={targets[pkg.name]} onSetEnabled={onSetEnabled} /> : null}
          </div>

        </div>
      </div>
      {pkg.examples === undefined ? null : <div className={css.bundleHero}>
        <div className={css.bundleExamples}>
          {pkg.examples.map((example) => {
            const prompt = resolveText(example.prompt)
            return <button key={example.id} type="button" className={css.bundleExample}
              aria-label={t('exampleOpen', { prompt })} onClick={() => { onOpenExample(prompt) }}>
              <span className={css.bundleExampleIdentity}><PackageArtwork src={pkg.meta?.icon} size={16} />{title}</span>
              <span className={css.bundleExamplePrompt}>{prompt}</span>
              <span className={css.bundleExampleArrow} aria-hidden="true"><IconChevronRightOutlineRegular size={14} /></span>
            </button>
          })}
        </div>
      </div>}
      {description === undefined ? null : <p className={css.bundleDescription}>{description}</p>}
      <MetadataError error={pkg.meta?.error} t={t} />
      {pkg.availability === 'missing' && pkg.installed
        ? <p className={css.reason} role="status">{t('statusMissingFiles')}</p> : null}
      {pkg.error === undefined ? null : <p className={css.reason} role="status">{t('reasonLabel')}: {managementText(pkg.error, t)}</p>}
      {pkg.readOnlyReason === undefined ? null : <p className={css.reason} role="status">{managementText({ code: pkg.readOnlyReason }, t)}</p>}
      {preview === undefined ? null : <PackagePreview src={preview} title={title} t={t} />}
      <div className={css.detailSections}>
        {detail}
        <UpdatesSection key={pkg.name} pkg={pkg} t={t} busy={busy} checking={updateChecking}
          onCheck={onCheckUpdates} onUpdate={onUpdate} onAutoUpdate={onAutoUpdate} onRestart={onRestart} />
        {renderSlot('plugins.detail.updates', { subject })}
        {companion !== undefined && (!companion.enabled || !companion.rows.some(row => row.enabled && row.phase === 'active'))
          ? <div className={css.managedUpdaterInactive} role="status">
            <span>{t('managedUpdaterInactive')}</span>
            <Button variant="outline" size="sm" disabled={companionBusy} onClick={() => { onSetCompanionEnabled?.(true) }}>
              {t('managedUpdaterEnable')}
            </Button>
          </div> : null}
        {pkg.features === undefined ? null : (
          <section className={css.detailSection} data-plugin-features>
            <div className={css.sectionHead}>
              <h4 className={css.sectionTitle}>{t('featuresLabel')}</h4>
              <span className={css.sectionCount}>{pkg.features.length}</span>
            </div>
            <ul className={css.featureList}>
              {featureGroups(pkg.features).map(group => <li key={group.kind ?? 'legacy'} className={css.featureGroup} {...group.kind === undefined ? {} : { 'data-feature-group': group.kind }}>
                {group.kind === undefined ? null : <div className={css.featureGroupHead}>
                  <span className={css.featureGroupTitle}>{t(FEATURE_KIND_KEYS[group.kind])}</span>
                  <span className={css.featureGroupCount}>{group.features.length}</span>
                </div>}
                <ul className={css.featureGroupItems}>
                  {group.features.map((feature) => {
                    const row = pkg.rows.find(candidate => candidate.rowId === feature.rowId)
                    return <FeatureRow key={feature.id} feature={feature} row={row} t={t} resolveText={resolveText}
                      busy={featureBusy(feature.id)} checked={targets[featureKey(pkg.name, feature.id)] ?? feature.enabled}
                      locked={pkg.readOnlyReason !== undefined || pkg.update?.restartRequired === true}
                      configure={row !== undefined && configure.has(row)
                        ? () => { setEditing({ rowId: row.rowId, featureId: feature.id }) } : undefined}
                      onChange={(enabled) => { onSetFeature(feature.id, enabled) }} />
                  })}
                </ul>
              </li>)}
            </ul>
          </section>
        )}
        {configured
          ? (
            <section className={css.detailSection} data-plugin-config>
              {renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })}
            </section>
          )
          : null}
        {companion !== undefined ? <ManagedModules packages={[pkg, companion]} t={t} resolveText={resolveText}
          targets={targets} busy={name => name === pkg.name ? busy : companionBusy}
          onSetEnabled={(name, enabled) => {
            if (name === pkg.name) onSetEnabled(enabled)
            else onSetCompanionEnabled?.(enabled)
          }} /> : pkg.availability === 'missing' ? null : <RowsSection
          rows={pkg.rows}
          t={t}
          resolveText={resolveText}
          toggle={pkg.enabled ? { busy: row => busy || pkg.update?.restartRequired === true || rowBusy(row),
            onSetEnabled: onSetRowEnabled } : undefined}
          targets={targets}
          configure={{ has: row => configure.has(row) && !pkg.features?.some(feature => feature.rowId === row.rowId),
            open: (row) => { setEditing({ rowId: row.rowId }) } }}
        />}
        <VersionSection
          pkg={pkg} check={versions} t={t} busy={busy} onEnsure={onEnsureVersions} onCheck={onCheckVersions} onUpdate={onUpdateVersion}
        />
        <DetailInformation source title={t(companion === undefined ? 'detailInformation' : 'managedInformation')} folded={companion !== undefined} entries={[
          { label: t('detailPackage'), value: <code data-plugin-name>{pkg.name}</code> },
          ...(pkg.version === undefined ? [] : [{ label: t('detailVersion'), value: pkg.version }]),
          ...(pkg.availability === 'missing' && pkg.source === undefined && !pkg.removable ? [] : [{ label: t('sourceSpec'),
            value: pkg.source !== undefined ? <code>{pkg.source}</code>
              : pkg.availability === 'missing' ? t(pkg.installed ? 'statusMissingFiles' : 'sourceNotInstalled') : t('sourceBuiltIn') }]),
          ...(pkg.installTarget === undefined ? [] : [
            { label: t('sourceTargetSpec'), value: <code>{pkg.installTarget.spec}</code> },
            { label: t('sourceTargetVersion'), value: pkg.installTarget.version },
          ]),
          ...(companion === undefined ? [] : [{ label: t('managedUpdaterPackage'), value: <code>{companion.name}</code> },
            ...companion.version === undefined ? [] : [{ label: t('managedUpdaterVersion'), value: companion.version }]]),
        ]} />
        {renderSlot('plugins.detail.section', { subject })}
      </div>
      {editing === null || editingRow === undefined || !configure.has(editingRow) ? null : <Modal open
        title={t('configureRow', { name: editingFeature === undefined ? rowText(editingRow, resolveText).title : resolveText(editingFeature.title) })} closeLabel={t('close')}
        onClose={() => { setEditing(null) }} className={css.featureConfigDialog as string}
        contentClassName={css.featureConfigContent as string}>
        {renderSlot('plugins.row.config', { view: 'page', ...editing.featureId === undefined ? {} : { featureId: editing.featureId }, form: rowForm(editingRow) },
          { entryKey: rowConfigKey(pkg.name, editingRow.rowId) })}
      </Modal>}

    </div>
  )
}

/** Output lines an install run's terminal shows before its middle folds: the first and last six of a long pnpm log. */
const INSTALL_TERMINAL_LINES = 12

/** The install terminal's display copy, from the tab's dictionary. */
function terminalLabels(t: Translate): TerminalBlockLabels {
  return {
    commandLine: line => t('terminalCommandLine', { n: String(line) }),
    /* v8 ignore next -- the Host reports a killed pnpm as a null exit code, never a signal name; the label interface needs one */
    signal: signal => t('terminalSignal', { signal }),
    exitCode: code => t('terminalExitCode', { code: String(code) }),
    noExitCode: t('terminalNoExitCode'),
    running: t('terminalRunning'),
    failed: t('terminalFailed'),
    done: t('terminalDone'),
    copy: t('terminalCopy'),
    copied: t('terminalCopied'),
    noOutput: t('terminalNoOutput'),
    collapseAria: t('terminalCollapseAria'),
    collapse: t('terminalCollapse'),
    expandAria: hidden => t('terminalExpandAria', { n: String(hidden) }),
    expand: hidden => t('terminalExpand', { n: String(hidden) }),
  }
}

/** The sentence under the field for a spec the check refused. */
const INPUT_PROBLEM_KEYS = {
  'invalid-spec': 'installProblemInvalid',
  'already-installed': 'installProblemInstalled',
  'shipped': 'installProblemShipped',
  'not-found': 'installProblemNotFound',
  'not-a-package': 'installProblemNotPackage',
  'not-a-bundle': 'installProblemNotBundle',
  'network': 'installProblemNetwork',
  'unknown': 'installProblemUnknown',
} satisfies Record<InstallInputError['problem'], PluginManagerLocaleKey>

/** One row of the install guide: a spec form's title, its example, and where the person finds it. */
interface GuideExample {
  readonly key: string
  readonly titleKey: PluginManagerLocaleKey
  readonly exampleKey: PluginManagerLocaleKey
  readonly hintKey: PluginManagerLocaleKey
}

/** The spec form the install guide shows, with an example the person can drop into the field. */
const GUIDE_EXAMPLES = [
  { key: 'id', titleKey: 'installGuideIdTitle', exampleKey: 'installGuideIdExample', hintKey: 'installGuideIdHint' },
] as const satisfies readonly GuideExample[]

/** The one-line reading of a classified pnpm failure. */
const FAILURE_KIND_KEYS = {
  'pnpm-missing': 'installFailurePnpmMissing',
  'timeout': 'installFailureTimeout',
  'not-found': 'installFailureNotFound',
  'no-matching-version': 'installFailureNoMatchingVersion',
  'network': 'installFailureNetwork',
  'disk-full': 'installFailureDiskFull',
  'permission': 'installFailurePermission',
  'build-blocked': 'installFailureBuildBlocked',
  'integrity': 'installFailureIntegrity',
  'unknown': 'installFailureGeneric',
} satisfies Record<PluginInstallFailureKind, PluginManagerLocaleKey>

/** The navigation value of the page's own tab; contributed tabs use their registration ids. */
const INSTALLED_TAB = 'installed'

/** The heading of each screen past the spec. */
const SCREEN_TITLE_KEYS = {
  starting: 'installStarting',
  running: 'installingTitle',
  cancelling: 'installCancelling',
  applying: 'installApplying',
  unconfirmed: 'installUnconfirmedTitle',
  unknown: 'installUnknownTitle',
  done: 'installedTitle',
  failed: 'installFailedTitle',
} satisfies Record<Exclude<InstallState['phase'], 'idle' | 'checking'>, PluginManagerLocaleKey>

/** What the spec's kind reads as when the package carries no description of its own. */
const SUBJECT_KIND_KEYS = {
  registry: undefined,
  path: 'installSubjectPath',
  git: 'installSubjectGit',
  tarball: 'installSubjectTarball',
} satisfies Record<InstallSubject['kind'], PluginManagerLocaleKey | undefined>

/** A check no registry answered names every registry asked; any other refusal reads by its problem. */
function inputProblemSentence(problem: InstallInputError, t: Translate, resolved: string | null): string {
  const asked = problem.registries ?? []
  return problem.problem === 'network' && asked.length > 1
    ? t('installProblemNetworkAll', { registries: registryList(asked, t, resolved) })
    : t(INPUT_PROBLEM_KEYS[problem.problem], { reason: problem.reason })
}

/** The registries asked, by name, in the dictionary's list form. */
function registryList(registries: readonly Registry[], t: Translate, resolved: string | null): string {
  return registries.map(registry => registryText(registry, t, resolved).name).join(t('registryListSeparator'))
}

/** An option's name with its host in tertiary text, unless the host is the name. */
function registryOption(registry: Registry, t: Translate, resolved: string | null): ReactNode {
  const { name, host } = registryText(registry, t, resolved)
  return name === host ? name : <>{name}{' '}<span className={css.registryHint}>{host}</span></>
}

/**
 * The failed screen's one line: a pnpm failure by its kind, a refusal by its
 * code, any other failure in the Host's words; the run's output stays behind the details.
 * A run the Host laid at the spec's own host says so; one it laid at a registry
 * names every registry asked when there were several.
 */
function failureText(failure: InstallState['failure'], t: Translate, install?: Pick<InstallState, 'attempts' | 'subject' | 'registries'>): string {
  if (failure === null) return t('installFailureGeneric')
  // A compatibility refusal is the package's own answer, whatever pnpm's exit classified the run as.
  if (failure.code === 'incompatible-version') {
    const incompatible = failure.incompatible === undefined ? {} : { incompatible: failure.incompatible }
    return managementText({ code: failure.code, installing: true, ...incompatible }, t)
  }
  // Blocked scripts the Host could not name leave the person to allow them in the profile's pnpm settings by hand.
  if (failure.kind === 'build-blocked' && !failure.pendingBuilds?.length) return t('installFailureBuildBlockedManual')
  const host = install?.subject?.host
  if (failure.failedAt === 'spec-host' && host !== undefined) return t('installFailureNetworkHost', { host })
  const asked = install?.attempts?.registries ?? []
  if (failure.failedAt === 'registry' && (failure.kind === 'network' || failure.kind === 'timeout') && asked.length > 1) {
    return t('installFailureNetworkAll', { registries: registryList(asked, t, install?.registries?.resolved ?? null) })
  }
  if (failure.kind !== undefined) return t(FAILURE_KIND_KEYS[failure.kind])
  if (failure.code !== undefined) return managementText({ code: failure.code, diagnostic: failure.reason }, t)
  return failure.reason === '' ? t('installFailureGeneric') : failure.reason
}

interface SubjectLines {
  readonly spec: string
  readonly title: string
  readonly description?: string | undefined
  readonly version?: string | undefined
  /** A confirmed version is named by its tab, so the spec follows as reference text. */
  readonly showSpec: boolean
}

/** The package an install is about: its name, one-liner, version, and, when `showSpec` is set, its spec. */
function SubjectBlock({ lines, t }: { readonly lines: SubjectLines; readonly t: Translate }): ReactNode {
  return (
    <div className={css.subject} data-install-subject={lines.spec}>
      <p className={css.subjectName}>{lines.title}</p>
      {lines.description === undefined ? null : <p className={css.subjectDesc}>{lines.description}</p>}
      {lines.version === undefined ? null : <p className={css.subjectMeta}>{t('installVersion', { version: lines.version })}</p>}
      {lines.showSpec ? <p className={css.subjectSpec}>{lines.spec}</p> : null}
    </div>
  )
}

/** The checked package as the Host read it before installing; a confirmed version keeps its tab's name and version. */
function SubjectCard({ subject, confirmed, t }: {
  readonly subject: InstallSubject
  readonly confirmed: InstallState['confirmed']
  readonly t: Translate
}): ReactNode {
  const kindKey = SUBJECT_KIND_KEYS[subject.kind]
  return (
    <SubjectBlock t={t} lines={{
      spec: subject.spec,
      title: confirmed?.title ?? subject.name ?? subject.spec,
      description: subject.description ?? (kindKey === undefined ? undefined : t(kindKey)),
      version: subject.version ?? confirmed?.version,
      showSpec: confirmed !== undefined,
    }} />
  )
}

/** Track one install field's composition, including Safari's 10ms post-composition Enter window. */
function useInstallComposition(active: boolean) {
  const composition = useRef({ active: false, until: 0 })
  useEffect(() => { composition.current = { active: false, until: 0 } }, [active])
  return {
    onCompositionStart: () => { composition.current.active = true },
    onCompositionEnd: () => { composition.current = { active: false, until: Date.now() + 10 } },
    onBlur: () => { composition.current = { active: false, until: 0 } },
    isComposing: (event: KeyboardEvent) => event.isComposing || Reflect.get(event, 'keyCode') === 229
      || composition.current.active || Date.now() < composition.current.until,
  }
}

/**
 * The install dialog: the spec and its check, then the installing, installed,
 * and failed screens over the same subject card. A failed run that left
 * install scripts undecided shows them for approval in place of plain retry.
 */
function InstallDialog({
  install, installedPackage, t, resolveText, onClose, onEditSpec, onRun, onCancel, onReconcile, onToggleDetails,
  onEnableNow, onApproveBuilds,
  onToggleRegistry, onChooseRegistry, onChangeRegistry, onUseGithubMirror,
}: {
  readonly install: InstallState
  readonly installedPackage: PackageView | undefined
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly onClose: () => void
  readonly onEditSpec: (text: string) => void
  readonly onRun: () => void
  readonly onCancel: () => void
  readonly onReconcile: () => void
  readonly onToggleDetails: () => void
  readonly onEnableNow: (enabledFeatureIds?: string[]) => void
  readonly onApproveBuilds: () => void
  readonly onToggleRegistry: () => void
  readonly onChooseRegistry: (choice: RegistryChoice) => void
  /** From the failed screen: back to the spec with the registry options unfolded. */
  readonly onChangeRegistry: () => void
  readonly onUseGithubMirror: () => void
}): ReactNode {
  const errorId = useId()
  const templateHintId = useId()
  const guideId = useId()
  const approvalId = useId()
  const registryId = useId()
  const registryErrorId = useId()
  const [guideOpen, setGuideOpen] = useState(false)
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([])
  const [customRegistryDraft, setCustomRegistryDraft] = useState('')
  const { phase } = install
  useEffect(() => {
    setSelectedFeatures(installedPackage?.features?.filter(feature => feature.enabled).map(feature => feature.id) ?? [])
  }, [install.installed, installedPackage?.name])
  // The registry options float over the dialog from their toggle, so unfolding them never adds to its height;
  // the store folds them when a run starts, so they show at the spec only.
  const registryToggleRef = useRef<HTMLButtonElement | null>(null)
  const registryPanelRef = useRef<HTMLFieldSetElement | null>(null)
  const registryCustomRef = useRef<HTMLInputElement | null>(null)
  const registryShown = install.registryOpen && phase === 'idle'
  const specComposition = useInstallComposition(install.open && phase === 'idle')
  const registryComposition = useInstallComposition(install.open && registryShown)
  const registryPosition = useAnchoredPosition({
    open: registryShown, anchorRef: registryToggleRef, panelRef: registryPanelRef, align: 'end', gap: 6, margin: 12,
  })
  const registryReady = registryShown && registryPosition !== null
  useEffect(() => {
    if (registryReady && install.registryError) registryCustomRef.current?.focus()
  }, [registryReady, install.registryError])
  // The hook only ever asks to close.
  useDismissOnOutsidePointer(registryToggleRef, registryShown, onToggleRegistry, registryPanelRef)
  useEffect(() => {
    if (!registryShown) return
    // Escape folds the options and goes no further: the dialog under them listens for the same key.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onToggleRegistry()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [registryShown, onToggleRegistry])
  if (githubRecoveryRegistry(install) !== undefined) {
    const anotherWay = asksMirror(install)
    return (
      <Modal
        open={install.open}
        onClose={onClose}
        title={t(install.failure?.kind === 'timeout' ? 'installGithubTimeoutTitle' : 'installGithubFailedTitle')}
        closeLabel={t('close')}
        description={t('installGithubFailedDescription')}
        footer={(
          <>
            <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
            <Button
              variant="primary"
              autoFocus
              onClick={() => {
                // The mirror is already asked, so the form opens with the package-name guide.
                if (anotherWay) setGuideOpen(true)
                onUseGithubMirror()
              }}
            >
              {t(anotherWay ? 'installTryAnotherWay' : 'installUseGithubMirror')}
            </Button>
          </>
        )}
      />
    )
  }
  if ((phase === 'idle' || phase === 'checking') && install.confirmed !== undefined) {
    // A confirmed spec has no form to return to: the dialog names the plugin and version above the spec, with its
    // check, a refusal with a retry, or, after a cancelled run, Install.
    const checking = phase === 'checking'
    const problem = install.inputError
    return (
      <Modal
        open={install.open}
        onClose={onClose}
        title={t(problem === null ? 'installConfirmedTitle' : 'installConfirmedRefused')}
        closeLabel={t('close')}
        className={css.installDialog as string}
        footer={checking ? undefined : (
          <>
            <Button variant="outline" onClick={onClose}>{t('close')}</Button>
            <Button variant="primary" autoFocus onClick={onRun}>{t(problem === null ? 'installRun' : 'retry')}</Button>
          </>
        )}
      >
        <div className={css.installBody} data-install-phase={phase}>
          <SubjectBlock t={t} lines={{ spec: install.spec, ...install.confirmed, showSpec: true }} />
          {checking
            ? <p className={`${css.status} ${css.statusWithDot}`} role="status"><StateDot state="ongoing" />{t('installChecking')}</p>
            : problem === null
              ? null
              : (
                <p className={css.inputError} role="alert">{inputProblemSentence(problem, t, install.registries?.resolved ?? null)}</p>
              )}
        </div>
      </Modal>
    )
  }
  if (phase === 'idle' || phase === 'checking') {
    const checking = phase === 'checking'
    const empty = install.spec.trim() === ''
    const choice = install.registry
    const resolved = install.registries?.resolved ?? null
    const chosenTitle = choice.kind === 'custom' ? t('registryCustom') : registryText(choice.registry, t, resolved).name
    const inputSentence = install.inputError === null ? null : inputProblemSentence(install.inputError, t, resolved)
    const templateHint = install.spec === INSTALL_GIT_EXAMPLE
      ? t('installGitTemplateHint')
      : install.spec === INSTALL_PATH_EXAMPLE ? t('installPathTemplateHint') : null
    return (
      <Modal
        open={install.open}
        onClose={onClose}
        title={t('installTitle')}
        closeLabel={t('close')}
        {...install.mirrorRecovery ? {} : { description: t('installDescription') }}
        className={css.installDialog as string}
        contentClassName={css.installContent as string}
        footer={(
          <div className={css.installFooter}>
            <p className={css.installSafety} role="note">
              <IconWarningOutlineRegular size={14} aria-hidden="true" />
              <span className={css.installSafetyText}>
                <span>{t('installGuideSafety')}</span>
                <span>{t('installUpgradeNotice')}</span>
              </span>
            </p>
            <Button variant="primary" className={css.wide} disabled={checking || empty} aria-busy={checking} onClick={onRun}>
              {checking ? <StateDot state="ongoing" /> : null}
              {t(checking ? 'installChecking' : 'installRun')}
            </Button>
          </div>
        )}
      >
        <div className={css.installBody}>
          <div className={css.installField}>
            <input
              type="text"
              autoFocus={install.mirrorRecovery === true}
              data-modal-autofocus
              value={install.spec}
              placeholder={t('installSpecPlaceholder')}
              disabled={checking}
              aria-label={t(install.mirrorRecovery ? 'installPackageLabel' : 'installSpecLabel')}
              aria-invalid={install.inputError !== null}
              aria-describedby={inputSentence !== null ? errorId : templateHint !== null ? templateHintId : undefined}
              onChange={(event) => { onEditSpec(event.currentTarget.value) }}
              onCompositionStart={specComposition.onCompositionStart}
              onCompositionEnd={specComposition.onCompositionEnd}
              onBlur={specComposition.onBlur}
              onKeyDown={(event) => {
                if (specComposition.isComposing(event.nativeEvent)) return
                if (event.key === 'Enter' && !empty && !checking) onRun()
              }}
            />
          </div>
          {inputSentence === null
            ? null
            : <p id={errorId} className={css.inputError} role="alert">{inputSentence}</p>}
          {inputSentence === null && templateHint !== null
            ? <p id={templateHintId} className={css.templateHint} role="status">{templateHint}</p>
            : null}
          <div className={css.optionsRow}>
            <button
              type="button"
              className={css.guideToggle}
              aria-expanded={guideOpen}
              aria-controls={guideId}
              onClick={() => { setGuideOpen(open => !open) }}
            >
              <IconChevronDownOutlineRegular className={css.guideChevron} aria-hidden="true" />
              <span>{t(guideOpen ? 'installGuideHide' : 'installGuideToggle')}</span>
            </button>
            <button
              ref={registryToggleRef}
              type="button"
              className={css.registryToggle}
              aria-expanded={install.registryOpen}
              aria-controls={registryId}
              aria-haspopup="dialog"
              disabled={checking}
              onClick={onToggleRegistry}
            >
              <span>{t('registryToggle')}</span>
              {' '}
              <span className={css.registryChosen}>{chosenTitle}</span>
              <IconChevronDownOutlineRegular className={css.guideChevron} aria-hidden="true" />
            </button>
          </div>
          {guideOpen
            ? (
              <div id={guideId} className={css.guide} data-install-guide>
                <ol className={css.guideList}>
                  {GUIDE_EXAMPLES.map(({ key, titleKey, exampleKey, hintKey }) => (
                    <li key={key} className={css.guideItem}>
                      <div className={css.guideMain}>
                        <span className={css.guideTitle}>{t(titleKey)}</span>
                        <span className={css.guideHint}>{t(hintKey)}</span>
                        <span className={css.guideExample}>
                          <span className={css.guideExampleLabel}>{t('installGuideExampleLabel')}</span>
                          <code>{t(exampleKey)}</code>
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t('installGuideFillAria', { example: t(exampleKey) })}
                        disabled={checking}
                        onClick={() => { onEditSpec(t(exampleKey)) }}
                      >
                        {t('installGuideFill')}
                      </Button>
                    </li>
                  ))}
                </ol>
              </div>
            )
            : null}
          {registryShown
            ? createPortal(
              <fieldset
                ref={registryPanelRef}
                id={registryId}
                className={css.registry}
                style={registryPosition ?? { visibility: 'hidden', left: 0, top: 0 }}
                data-install-registry
                aria-label={t('registryLegend')}
                onKeyDown={(event) => {
                  if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return
                  event.preventDefault()
                  event.stopPropagation()
                  const radio = event.currentTarget.querySelector<HTMLInputElement>('input[type="radio"]:checked')
                  const field = registryCustomRef.current
                  if (event.shiftKey && event.target === field) radio?.focus()
                  else if (!event.shiftKey && event.target !== field) field?.focus()
                  else {
                    onToggleRegistry()
                    registryToggleRef.current?.focus()
                  }
                }}
              >
                {offeredRegistries(install.registries).map((registry) => {
                  const checked = choice.kind === 'offered' && choice.registry === registry
                  return (
                    <label key={registry ?? ''} className={css.registryOption} data-checked={checked}>
                      <input type="radio" name={registryId} checked={checked} onChange={() => {
                        if (choice.kind === 'custom') setCustomRegistryDraft(choice.url)
                        onChooseRegistry({ kind: 'offered', registry })
                      }} />
                      <span className={css.registryTitle}>{registryOption(registry, t, resolved)}</span>
                    </label>
                  )
                })}
                <div className={css.registryOption} data-checked={choice.kind === 'custom'}
                  onClick={(event) => {
                    // Keep label activation from moving focus back to the radio.
                    if (!(event.target instanceof HTMLInputElement)) event.preventDefault()
                    registryCustomRef.current?.focus()
                  }}>
                  <label className={css.registryCustomPick}>
                    <input
                      type="radio"
                      name={registryId}
                      checked={choice.kind === 'custom'}
                      onChange={() => {
                        onChooseRegistry({ kind: 'custom', url: customRegistryDraft })
                        registryCustomRef.current?.focus()
                      }}
                    />
                    <span className={css.registryTitle}><span>{t('registryCustom')}</span></span>
                  </label>
                  <input
                    ref={registryCustomRef}
                    type="text"
                    className={css.registryCustomField}
                    aria-label={t('registryCustom')}
                    placeholder={t('registryCustomPlaceholder')}
                    value={choice.kind === 'custom' ? choice.url : customRegistryDraft}
                    aria-invalid={install.registryError}
                    aria-describedby={install.registryError ? registryErrorId : undefined}
                    onFocus={() => {
                      if (pointerModality() && choice.kind !== 'custom') onChooseRegistry({ kind: 'custom', url: customRegistryDraft })
                    }}
                    onChange={(event) => { onChooseRegistry({ kind: 'custom', url: event.currentTarget.value }) }}
                    onCompositionStart={registryComposition.onCompositionStart}
                    onCompositionEnd={registryComposition.onCompositionEnd}
                    onBlur={registryComposition.onBlur}
                    onKeyDown={(event) => {
                      if (registryComposition.isComposing(event.nativeEvent)) return
                      if (event.key === 'Enter' && !empty) onRun()
                    }}
                  />
                  {install.registryError
                    ? <p id={registryErrorId} className={css.inputError} role="alert">{t('registryCustomInvalid')}</p>
                    : null}
                  <span className={css.registryHint}>{t('registryCustomHint')}</span>
                </div>
              </fieldset>,
              document.body,
            )
            : null}
        </div>
      </Modal>
    )
  }
  const heading = t(phase === 'done' && install.subject?.bundled ? 'installBundledTitle' : SCREEN_TITLE_KEYS[phase])
  const pending = isInstallPending(phase)
  const cancellable = phase === 'starting' || phase === 'running' || phase === 'unconfirmed'
  const stoppable = cancellable || phase === 'failed' || phase === 'unknown'
  const failure = install.failure
  const uncertainty = failure?.uncertainty
  const uncertaintyText = failure?.uncertainty === undefined ? null : t(({
    result: 'installResultUnconfirmed',
    cancellation: phase === 'applying' ? 'installApplyingCancellationError' : 'installCancelUnconfirmed',
    acceptance: 'installAwaitingAcceptance',
  } as const)[failure.uncertainty], { reason: failure.reason })
  const pendingBuilds = phase === 'failed' ? install.failure?.pendingBuilds ?? [] : []
  const approvable = pendingBuilds.length > 0
  const firstRun = install.runs[0]
  // The registries the Host asked, once there is more than one: the attempt under way while it runs, a badge on each run.
  const asked = install.attempts !== null && install.attempts.registries.length > 1 ? install.attempts : null
  const current = asked === null ? undefined : asked.registries.at(-1)
  const previous = asked === null ? undefined : asked.registries.at(-2)
  const resolved = install.registries?.resolved ?? null
  const attemptLine = pending && asked !== null && current !== undefined && previous !== undefined
    ? t('installAttempt', {
      previous: registryText(previous, t, resolved).name, registry: registryText(current, t, resolved).name,
      index: String(asked.registries.length), total: String(asked.total),
    })
    : null
  // Another registry is worth offering only for a failure the Host laid at the one it asked.
  const changeable = phase === 'failed' && !approvable && install.failure?.failedAt === 'registry' && install.confirmed === undefined
  const subject = install.subject
  return (
    <Modal open={install.open} onClose={onClose} title={heading} headless className={css.installDialog as string}>
      <div className={css.wizard} data-install-phase={phase}>
        <div className={css.wizardHead}>
          {phase === 'done' || (install.confirmed !== undefined && !pending)
            ? <span />
            : (
              <button type="button" className={css.wizardBack} aria-label={t(install.confirmed !== undefined ? 'cancel' : pending ? 'installCancelAndEdit' : 'installEditAria')}
                disabled={!stoppable} onClick={onCancel}>
                <IconChevronLeftOutlineMedium aria-hidden="true" />
                <span>{t(install.confirmed !== undefined ? 'cancel' : pending ? 'installCancelAndEdit' : 'installEdit')}</span>
              </button>
            )}
          <button
            type="button"
            className={css.wizardClose}
            aria-label={t(cancellable ? 'installCloseCancels' : 'close')}
            onClick={onClose}
          >
            <IconCloseOutlineMedium size={14} />
          </button>
        </div>
        <div className={css.wizardScroll}>
          <div className={css.wizardHero}>
            <span className={css.wizardIcon} data-state={pending ? 'ongoing' : phase === 'done' ? 'done' : 'error'} aria-hidden="true">
              {pending
                ? <StateDot state="ongoing" size={28} />
                : phase === 'done'
                  ? <IconCheckCircleFillRegular size={28} />
                  : <IconWarningOutlineRegular size={28} />}
            </span>
            <h2 className={css.wizardTitle} role={phase === 'failed' ? 'alert' : 'status'}>{heading}</h2>
            {phase === 'done' && subject?.bundled ? <p className={css.wizardSub}>{t('installBundledDescription')}</p> : null}
            {phase === 'failed' ? <p className={css.wizardSub}>{failureText(install.failure, t, install)}</p> : null}
            {attemptLine === null ? null : <p className={css.wizardSub}>{attemptLine}</p>}
            {uncertaintyText === null ? null : <p className={css.wizardSub} role="alert">{uncertaintyText}</p>}
            {phase === 'unknown' ? <p className={css.wizardSub}>{t('installUnknownDescription')}</p> : null}
          </div>
          {subject === null
            ? null
            : <SubjectCard subject={phase === 'done' && install.installedVersion !== null ? { ...subject, version: install.installedVersion } : subject} confirmed={install.confirmed} t={t} />}
          {approvable
            ? (
              <section className={css.approval} role="group" aria-labelledby={approvalId} data-install-approval>
                <h3 id={approvalId} className={css.approvalTitle}>{t('installApprovalTitle')}</h3>
                <p className={css.approvalText}>{t('installApprovalDescription')}</p>
                <ul className={css.approvalList}>
                  {pendingBuilds.map(name => <li key={name}><code>{name}</code></li>)}
                </ul>
                <p className={css.approvalText}>{t('installApprovalConsequence')}</p>
                <p className={css.approvalCaution}>{t('installApprovalCaution')}</p>
                <Button variant="primary" className={css.wide} onClick={onApproveBuilds}>{t('installApproveAndRetry')}</Button>
              </section>
            )
            : null}
          {phase === 'done' && install.installed === null
            ? <p className={css.result} role="status">{t('installDoneNothing')}</p>
            : null}
          {phase === 'done' && install.restartRequired
            ? <p className={css.resultWarn} role="status">{restartText('installDoneRestart', install.restartReason, t)}</p>
            : null}
          {phase === 'done' && subject?.kind === 'registry' && subject.name !== undefined && subject.version !== undefined
            && install.installedVersion !== null && install.installedVersion !== subject.version
            // A fallback registry can serve another release than the one inspected, so only a single-registry run is explained.
            && (install.attempts?.registries.length ?? 1) === 1
            ? (
              <p className={css.resultWarn} role="status">
                {t('installDoneOtherVersion', {
                  installed: install.installedVersion, version: subject.version, exact: `${subject.name}@${subject.version}`,
                })}
              </p>
            )
            : null}
          {phase === 'done' && install.approvedBuilds.length > 0
            ? <p className={css.result} role="status">{t('installDoneApproved', { names: install.approvedBuilds.join(', ') })}</p>
            : null}
          {phase === 'done' && installedPackage?.features !== undefined ? (
            <fieldset className={css.installFeatures}>
              <legend>{t('installFeaturesTitle')}</legend>
              <p>{t('installFeaturesDescription')}</p>
              {installedPackage.features.map(feature => <label key={feature.id}>
                <input type="checkbox" checked={selectedFeatures.includes(feature.id)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked
                    setSelectedFeatures(current => checked ? [...current, feature.id] : current.filter(id => id !== feature.id))
                  }} />
                <span>{resolveText(feature.title)}</span>
              </label>)}
            </fieldset>
          ) : null}
          <div className={css.wizardFoot}>
            {subject?.bundled ? null : (
              <button type="button" className={css.detailsToggle} aria-expanded={install.detailsOpen} onClick={onToggleDetails}>
                <span>{t(install.detailsOpen ? 'installDetailsHide' : 'installDetailsShow')}</span>
                <IconChevronDownOutlineRegular className={css.detailsChevron} aria-hidden="true" />
              </button>
            )}
            {uncertainty === 'result' ? <Button variant="outline" size="sm" className={css.footAction} onClick={onReconcile}>{t('installReconcile')}</Button> : null}
            {pending
              ? (
                <Button variant="outline" size="sm" className={css.footAction} disabled={!cancellable} onClick={onCancel}>
                  {t(phase === 'cancelling' ? 'installCancelling' : 'installCancel')}
                </Button>
              )
              : null}
            {phase === 'failed' && !approvable
              ? (
                <span className={css.wizardActions}>
                  {changeable
                    ? <Button variant="outline" size="sm" className={css.footAction} onClick={onChangeRegistry}>{t('installChangeRegistry')}</Button>
                    : null}
                  <Button variant="primary" size="sm" className={css.footAction} onClick={onRun}>{t('installRetry')}</Button>
                </span>
              )
              : null}
          </div>
          {install.detailsOpen
            ? (
              <div className={css.detailsBody}>
                <p className={css.installLocation}>{firstRun === undefined ? t('terminalNoOutput') : t('installLocation', { dir: firstRun.cwd })}</p>
                {install.runs.map((run, index) => {
                  const registry = asked?.registries[index]
                  return (
                    <div key={run.jobId} className={css.run}>
                      {registry === undefined
                        ? null
                        : <p className={css.attemptBadge}>{t('installAttemptBadge', { index: String(index + 1), registry: registryText(registry, t, resolved).name })}</p>}
                      <TerminalBlock
                        command={run.command}
                        output={run.output}
                        running={run.exitCode === undefined}
                        exitCode={run.exitCode}
                        maxLines={INSTALL_TERMINAL_LINES}
                        labels={{ ...terminalLabels(t), ...phase === 'cancelling' ? { failed: t('installCancelledShort') } : {} }}
                        className={css.terminal}
                      />
                    </div>
                  )
                })}
              </div>
            )
            : null}
          {phase !== 'done'
            ? null
            : install.installed !== null && install.subject?.selection === undefined
              ? <Button variant="primary" className={css.wide} disabled={install.enabling}
                aria-busy={install.enabling} onClick={() => { onEnableNow(installedPackage?.features === undefined ? undefined : selectedFeatures) }}>{t('installEnableNow')}</Button>
              : <Button variant="primary" className={css.wide} onClick={onClose}>{t('installClose')}</Button>}
        </div>
      </div>
    </Modal>
  )
}

/** The confirmation an uninstall waits on. */
function ConfirmDialog({ name, t, onConfirm, onCancel }: {
  readonly name: string
  readonly t: Translate
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): ReactNode {
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('confirmUninstallTitle', { name })}
      closeLabel={t('close')}
      description={t('confirmUninstallDescription')}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" className={css.dangerButton} onClick={onConfirm}>
            {t('confirmUninstall')}
          </Button>
        </>
      )}
    />
  )
}

/** Render the plugin manager: the official plugins and installed bundles, their pages, the install dialog, and the confirmation. */
export function PluginManagerPage(props: PluginManagerPageProps): ReactNode {
  const { t, ensure, renderSlot, resolveText } = props
  const configurations = props.useConfigurations(snapshot => snapshot.view?.namespaces)
  const formFor = (id: string): ConfigPageForm | undefined => {
    if (!configurations?.some(view => view.ns === id)) return undefined
    const form = props.configForm<Record<string, unknown>>(id)
    return { state: form.getSnapshot(), mutate: (ops, revision) => form.mutate(ops, revision) }
  }
  const state = props.usePluginManager(snapshot => snapshot)
  const ledger = props.useConfigLedger(snapshot => snapshot)
  // What is open; a package that leaves the list (uninstalled) drops back to the cards.
  const view = props.useStore(state => state.view), { setView, setTab } = props.actions
  const tabs = props.usePluginTabs(snapshot => snapshot)
  const bundleDetails = props.useBundleDetails(snapshot => snapshot)
  const language = props.useLocale(snapshot => snapshot.active)
  const selectedTab = props.useStore(state => state.tab)
  // A contributed tab that left the ledger falls back to Installed, and stays there when it returns.
  const tab = tabs.some(item => item.id === selectedTab) ? selectedTab : INSTALLED_TAB
  useEffect(() => { if (tab !== selectedTab) setTab(tab) }, [tab, selectedTab, setTab])
  const tabsId = useId()
  const [activation, setActivation] = useState<string | null>(null)
  const [headerRef] = useState(props.createHeaderRef)
  useEffect(() => { ensure() }, [ensure])
  // Installation highlights visible cards without changing the user's current page.
  const { highlight, clearHighlight } = { highlight: state.highlight, clearHighlight: props.clearHighlight }
  useEffect(() => {
    if (highlight === null) return
    const card = document.querySelector(`[data-plugin-package="${highlight}"]`)
    if (card !== null && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timer = setTimeout(clearHighlight, HIGHLIGHT_MS)
    return () => { clearTimeout(timer) }
  }, [highlight, clearHighlight])
  const noticeLine = state.notice === null || state.notice.kind === 'refresh-failed' ? null : noticeText(state.notice, t)

  // 随安装交付且声明功能开关的业务组合包也进入管理列表；基础 profile 组合包保留在只读清单。
  const available = state.packages.filter(pkg => !HIDDEN_BUNDLES.has(pkg.name)
    && (pkg.listedByDefault !== false || pkg.enabled || pkg.installed || rowsRunning(pkg))
    && (pkg.installed || pkg.official || pkg.optional || (pkg.features?.length ?? 0) > 0 || pkg.error !== undefined))
  // 仅合并唯一所属且没有独立功能页的更新器；共享更新器和失去主插件的更新器仍保留入口。
  const updaterOwners = new Map<string, PackageView>()
  for (const candidate of available) {
    const owners = available.filter(owner => owner.updateManager === candidate.name && owner.name !== candidate.name)
    const owner = owners[0]
    if (owners.length === 1 && owner !== undefined && candidate.updateManager === undefined && (candidate.features?.length ?? 0) === 0) {
      updaterOwners.set(candidate.name, owner)
    }
  }
  const listed = available.filter(pkg => !updaterOwners.has(pkg.name))
  const mine = listed.filter(pkg => !pkg.official)
  const official = listed.filter(pkg => pkg.official)
  const ordered = orderOptionalBundles(official)
  const pinned = new Set(official.filter(pinnedToMainList).map(pkg => pkg.name))
  const extensions = ordered.filter(pkg => pinned.has(pkg.name))
  const more = ordered
  const loaded = state.status === 'ready' || state.status === 'error'
  const refreshing = state.refreshStatus === 'refreshing'
  const openName = view.kind === 'package' || view.kind === 'row' ? updaterOwners.get(view.name)?.name ?? view.name : undefined
  const openPkg = listed.find(pkg => pkg.name === openName)
  const companion = openPkg?.updateManager !== undefined && updaterOwners.get(openPkg.updateManager)?.name === openPkg.name
    ? available.find(pkg => pkg.name === openPkg.updateManager) : undefined
  const openItem = view.kind === 'item' ? ledger.items.find(item => item.id === view.id) : undefined
  const openRow = view.kind === 'row' && openPkg !== undefined ? openPkg.rows.find(row => row.rowId === view.rowId) : undefined
  const onInstalled = tab === INSTALLED_TAB
  const showsCards = !onInstalled || (openPkg === undefined && openItem === undefined)
  const detailFromMore = (view.kind === 'package' || view.kind === 'row')
    && (view.from === 'more' || (openPkg !== undefined && MORE_BUNDLES.includes(view.name) && !pinned.has(view.name)))
  const showsMoreList = onInstalled && showsCards && (view.kind === 'more' || detailFromMore)
  const showsMainList = showsCards && !showsMoreList
  const installedCards = onInstalled && showsCards
  const openPkgInMore = openPkg !== undefined && openPkg.official && detailFromMore
  const returnTab = view.kind === 'package' || view.kind === 'row' ? view.returnTab : undefined
  const backToMore = openPkgInMore && returnTab === undefined
  const pkgOrigin = returnTab !== undefined ? { returnTab } : backToMore ? { from: 'more' as const } : {}
  // The Installed tab's panel, whatever it currently shows; the More list is not a tab panel.
  const installedPanel = tabs.length === 0 || showsMoreList
    ? {}
    : { role: 'tabpanel', id: `${tabsId}-${INSTALLED_TAB}-panel`, 'aria-labelledby': `${tabsId}-${INSTALLED_TAB}` }
  const activated = listed.find(pkg => pkg.name === activation && pkg.enabled && !state.busy.includes(pkg.name))
  const setBundleEnabled = (name: string, enabled: boolean): void => {
    setActivation(enabled ? name : null)
    props.setEnabled(name, enabled)
  }
  const setRowEnabled = (row: PackageRow, enabled: boolean): void => {
    /* v8 ignore next -- a row without a live entry has its switch disabled */
    if (row.entryId !== undefined) props.setRowEnabled(row.entryId, enabled)
  }
  const configure = (pkg: PackageView): RowConfigure => ({
    has: row => ledger.rows.has(rowConfigKey(pkg.name, row.rowId)),
    open: (row) => { setView({ kind: 'row', name: pkg.name, rowId: row.rowId, ...pkgOrigin }) },
  })
  const updates = updatesNote(mine, state.versions, t)
  const updatePkg = state.update === null ? undefined : state.packages.find(pkg => pkg.name === state.update?.packageName)
  const packageBusy = (pkg: PackageView): boolean => bundleBusy(state, pkg.name)
  const packageCard = (pkg: PackageView): ReactNode => (
    <PackageCard
      key={pkg.name}
      pkg={pkg}
      t={t}
      resolveText={resolveText}
      busy={packageBusy(pkg)}
      target={state.pendingTargets[pkg.name]}
      highlighted={state.highlight === pkg.name}
      newer={versionUpdate(state.versions[pkg.name])}
      onOpen={() => { setActivation(null); setView({ kind: 'package', name: pkg.name, ...showsMoreList ? { from: 'more' } : {} }) }}
      onSetEnabled={(enabled) => { setActivation(enabled ? pkg.name : null); props.setEnabled(pkg.name, enabled) }}
      onUpdate={() => { props.updateBundle(pkg.name) }}
      onRestart={() => { props.showUpdateRestart(pkg.name) }}
    />
  )
  const basicCards = ledger.items.map(item => (
    <ItemCard key={`item:${item.id}`} item={item} t={t} renderSlot={renderSlot} onOpen={() => { setView({ kind: 'item', id: item.id }) }} />
  ))
  const renderGroup = (id: 'basic' | 'extensions' | 'bundles', heading: string, cards: readonly ReactNode[]): ReactNode => {
    const offersMore = id === 'extensions' && more.length > 0
    if (cards.length === 0 && !offersMore) return null
    return (
      <section className={css.group} data-plugin-scope="global" data-plugin-group={id}>
        <div className={css.groupHead}>
          <h3 className={css.groupTitle}>{heading}</h3>
          {offersMore ? (
            <Button size="sm" className={css.groupMore} onClick={() => { setView({ kind: 'more' }) }}>
              {t('moreAction')}<IconChevronRightOutlineRegular size={14} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        {cards.length > 0 ? <ul className={css.cards}>{cards}</ul> : null}
      </section>
    )
  }

  return (
    <section className={css.page} data-plugin-panel aria-busy={state.status === 'loading' || refreshing}>
      {showsMoreList ? (
        <header className={css.moreHead} data-window-drag>
          <Button size="sm" className={css.moreBack} aria-label={t('backToList')} onClick={() => { setView({ kind: 'list' }) }}>
            <IconChevronLeftOutlineMedium size={20} aria-hidden="true" />
          </Button>
          <h1 className={css.pageTitle}>{t('moreTitle')}</h1>
        </header>
      ) : null}
      <div className={css.pageBody} data-plugin-body>
        {showsMainList
          ? (
            <div
              className={`${css.pageBar}${tabs.length > 0 ? ` ${css.pageBarWithTabs}` : ''}`}
              data-plugin-bar
              ref={headerRef}
            >
              <header className={css.pageHead} data-window-drag>
                <div className={css.pageHeading}>
                  <h1 className={css.pageTitle} data-plugin-header-part="title">{t('title')}</h1>
                  <div className={css.pageIntro} data-plugin-header-part="intro">
                    <span>{t('intro')}</span>
                    <Tooltip label={t('infoDescription')} side="bottom" delayMs={300} maxWidth={300} portal openOnClick>
                      <Button variant="ghost" size="sm" className={css.infoButton} aria-label={t('infoLabel')}>
                        <IconInfoOutlineRegular size={11} aria-hidden="true" />
                      </Button>
                    </Tooltip>
                  </div>
                </div>
                <div className={css.toolbar} data-plugin-toolbar data-plugin-header-part="toolbar" hidden={!onInstalled}>
                  {updates === undefined ? null : <span className={css.updatesNote} data-tone={updates.tone}>{updates.text}</span>}
                  <Tooltip label={t('refresh')} delayMs={500} focusDelayMs={500} side="bottom" portal disabled={!loaded || refreshing}>
                    <Button variant="outline" size="sm" className={css.addButton} aria-label={t('refresh')} aria-busy={refreshing}
                      disabled={!loaded || refreshing} onClick={props.refresh}
                      icon={refreshing ? <StateDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={13} />}>
                      <span className={css.toolbarLabel}>{t('refresh')}</span>
                    </Button>
                  </Tooltip>
                  {state.install.requestId === undefined
                    ? <AddPluginMenu t={t} disabled={!loaded} openInstall={props.openInstall} renderSlot={renderSlot} />
                    : (
                      <Tooltip label={t('installViewTask')} side="bottom" delayMs={500} focusDelayMs={500} portal disabled={!loaded}>
                        <Button variant="primary" size="sm" className={css.addButton} icon={<IconPlusOutlineRegular size={13} />}
                          aria-label={t('installViewTask')} disabled={!loaded} onClick={props.openInstall}>
                          <span className={css.toolbarLabel}>{t('installViewTask')}</span>
                        </Button>
                      </Tooltip>
                    )}
                </div>
                {tabs.length > 0
                  ? (
                    <div className={css.pageTabs} data-plugin-header-part="tabs">
                      <SegmentedTabs
                        size="sm"
                        className={css.pageTabList}
                        label={t('tabsLabel')}
                        value={tab}
                        onChange={(next) => { setTab(next) }}
                        items={[
                          { value: INSTALLED_TAB, label: t('installedTab'), id: `${tabsId}-${INSTALLED_TAB}`, panelId: `${tabsId}-${INSTALLED_TAB}-panel` },
                          ...tabs.map(item => ({ value: item.id, label: item.label, id: `${tabsId}-${item.id}`, panelId: `${tabsId}-${item.id}-panel` })),
                        ]}
                      />
                    </div>
                  )
                  : null}
              </header>
            </div>
          )
          : null}

        {!onInstalled
          ? (
            <div role="tabpanel" id={`${tabsId}-${tab}-panel`} aria-labelledby={`${tabsId}-${tab}`} className={css.tabPanel}>
              {renderSlot('plugins.tab', {
                install: props.installFrom,
                openPackage: (name) => { setTab(INSTALLED_TAB); setView({ kind: 'package', name, returnTab: tab }) },
              }, { only: tab })}
            </div>
          )
          : null}
        {installedCards && !loaded ? (
          <div className={css.installedPanel} {...installedPanel}>
            {state.status === 'loading' ? <ListSkeleton label={t('loading')} /> : null}
            {state.status === 'unavailable' ? (
              <p className={`${css.status} ${css.statusWithDot}`} role="status">
                <StateDot state="idle" />{t('unavailable')}
              </p>
            ) : null}
          </div>
        ) : null}
        {state.notice === null || noticeLine === null
          ? null
          : (
            <Toast
              key={state.notice.seq}
              text={noticeLine}
              icon={<IconWarningOutlineRegular />}
              holdMs={toastHoldMs(noticeLine)}
              onDone={props.dismissNotice}
            />
          )}
        {!showsCards && state.status === 'error' && !refreshing
          ? (
            <div className={css.failure}>
              <p className={css.statusWithDot} role="alert">
                <StateDot state="error" />{t(state.refreshStatus === 'failed' ? 'refreshError' : 'error')}
              </p>
              <Button variant="outline" size="sm" onClick={props.refresh}>{t('retry')}</Button>
            </div>
          )
          : null}
        {onInstalled && loaded && openPkg !== undefined && openRow !== undefined
          ? (
            <RowDetail
              pkg={openPkg}
              row={openRow}
              form={formFor(openRow.rowId)}
              t={t}
              resolveText={resolveText}
              renderSlot={renderSlot}
              onBack={() => { setView({ kind: 'package', name: openPkg.name, ...pkgOrigin }) }}
            />
          )
          : null}
        {onInstalled && loaded && openPkg !== undefined && openRow === undefined
          ? (
            <PackageDetail
              key={openPkg.name}
              companion={companion}
              companionBusy={companion !== undefined && state.busy.includes(companion.name)}
              onSetCompanionEnabled={companion === undefined ? undefined : (enabled) => { props.setEnabled(companion.name, enabled) }}
              featureBusy={featureId => state.busy.includes(featureKey(openPkg.name, featureId))}
              targets={state.pendingTargets}
              rowForm={row => formFor(row.rowId)}
              onSetFeature={(featureId, enabled) => { props.setFeature(openPkg.name, featureId, enabled) }}
              onOpenExample={(prompt) => { props.openExample(openPkg.name, prompt) }}
              updateChecking={state.busy.includes('updates:check')}
              onCheckUpdates={props.checkUpdates}
              onUpdate={() => { props.updateBundle(openPkg.name) }}
              onAutoUpdate={(enabled) => { props.setAutoUpdate(openPkg.name, enabled) }}
              onRestart={() => { props.showUpdateRestart(openPkg.name) }}
              pkg={openPkg}
              t={t}
              resolveText={resolveText}
              busy={packageBusy(openPkg)}
              rowBusy={row => row.entryId !== undefined && state.busy.includes(rowKey(row.entryId))}
              configured={ledger.bundles.has(openPkg.name)}
              configure={configure(openPkg)}
              renderSlot={renderSlot}
              inMore={backToMore}
              detail={(
                <BundleDetailSection name={openPkg.name} version={openPkg.version} fromNpm={openPkg.availability === 'missing'}
                  language={language} details={bundleDetails} t={t}
                  load={props.loadDetail} retry={props.retryDetail} image={props.detailImage} />
              )}
              onBack={() => {
                if (returnTab !== undefined) setTab(returnTab)
                setView({ kind: backToMore ? 'more' : 'list' })
              }}
              onSetEnabled={(enabled) => { setBundleEnabled(openPkg.name, enabled) }}
              onUninstall={() => { props.uninstall(openPkg.name) }}
              onOfficialUpdate={() => { props.update(openPkg.name) }}
              onSetRowEnabled={setRowEnabled}
              versions={state.versions[openPkg.name]}
              onEnsureVersions={props.ensureVersions}
              onCheckVersions={() => { props.checkVersions(openPkg.name) }}
              onUpdateVersion={(version) => { props.openUpdate(openPkg.name, version) }}
            />
          )
          : null}
        {onInstalled && loaded && openItem !== undefined
          ? <ItemDetail form={formFor(openItem.id)} item={openItem} t={t} renderSlot={renderSlot} onBack={() => { setView({ kind: 'list' }) }} />
          : null}
        {loaded && installedCards
          ? basicCards.length === 0 && official.length === 0 && mine.length === 0 && state.status !== 'error'
            ? <div className={css.installedPanel} {...installedPanel}><p className={css.empty}>{t('empty')}</p></div>
            : (
              <div className={css.installedPanel} {...installedPanel}>
                {showsMoreList ? (
                  <section className={css.group} data-plugin-scope="global" data-plugin-group="more">
                    <ul className={css.cards}>{more.map(packageCard)}</ul>
                  </section>
                ) : (
                  <>
                    {renderGroup('basic', t('basicTitle'), basicCards)}
                    {renderGroup('extensions', t('extensionsTitle'), extensions.map(packageCard))}
                    {renderGroup('bundles', t('bundlesTitle'), mine.map(packageCard))}
                  </>
                )}
                {/* A failed package read trails the groups it left incomplete: right under the groups on a
                    first-load failure, and after the kept cards when a refresh fails over stale data. */}
                {state.status === 'error' && !refreshing
                  ? (
                    <div className={css.failure}>
                      <p className={css.statusWithDot} role="alert">
                        <StateDot state="error" />{t(state.refreshStatus === 'failed' ? 'refreshError' : 'error')}
                      </p>
                      <Button variant="outline" size="sm" onClick={props.refresh}>{t('retry')}</Button>
                    </div>
                  )
                  : null}
              </div>
            )
          : null}
        {onInstalled && activated !== undefined && !state.install.open
          ? renderSlot('plugins.bundle.activation', {
            packageName: activated.name,
            onDismiss: () => { setActivation(null) },
            onOpenDetails: () => {
              setActivation(null)
              setView({ kind: 'package', name: activated.name, ...showsMoreList ? { from: 'more' } : {} })
            },
          }, { entryKey: activated.name }) : null}
      </div>
      {state.update === null ? null : (
        <UpdateDialog
          update={state.update}
          title={updatePkg === undefined ? state.update.packageName : packageText(updatePkg, resolveText).title}
          t={t}
          onRun={props.runUpdate}
          onClose={props.closeUpdate}
          onToggleOutput={props.toggleUpdateOutput}
        />
      )}
      <InstallDialog
        install={state.install}
        installedPackage={state.packages.find(pkg => pkg.name === state.install.installed)}
        t={t}
        resolveText={resolveText}
        onClose={props.closeInstall}
        onEditSpec={props.editInstallSpec}
        onRun={props.runInstall}
        onCancel={props.cancelInstall}
        onReconcile={props.reconcileInstall}
        onToggleDetails={props.toggleInstallDetails}
        onEnableNow={(ids) => {
          setActivation(state.install.installed)
          if (ids === undefined) props.enableInstalled(); else props.enableInstalled(ids)
        }}
        onApproveBuilds={props.approveBuildsAndRetry}
        onToggleRegistry={props.toggleRegistryOptions}
        onChooseRegistry={props.chooseRegistry}
        onChangeRegistry={props.changeRegistry}
        onUseGithubMirror={props.useGithubMirror}
      />
      {state.confirm === null
        ? null
        : (
          <ConfirmDialog
            name={packageText(
              state.packages.find(pkg => pkg.name === state.confirm?.packageName) ?? { name: state.confirm.packageName },
              resolveText,
            ).title}
            t={t}
            onConfirm={props.confirm}
            onCancel={props.cancelConfirm}
          />
        )}
    </section>
  )
}
