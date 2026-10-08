import { downloadFilenameBase } from '../shared/afp-download-filenames.js'
import { createAfpSelector } from './afp-selector.js'
import { downloadQualityChoices } from './afp-download-qualities.js'

const errorKeys = {
  'invalid-request': 'downloadServiceOutdated', 'response-too-large': 'downloadResponseTooLarge',
  'download-auth-unavailable': 'downloadAuthFailed', 'download-photo-unavailable': 'downloadPhotoFailed',
  'download-no-renditions': 'downloadNoRenditions', 'download-balance-unavailable': 'downloadBalanceRequired',
  'download-insufficient-credit': 'downloadInsufficientCredit', 'download-picker-unavailable': 'downloadPickerUnavailable',
  'download-directory-expired': 'downloadDirectoryExpired', 'download-options-expired': 'downloadOptionsExpired',
  'download-confirmation-expired': 'downloadConfirmationExpired', 'download-write-disabled': 'downloadPaidDisabled',
  'download-account-changed': 'downloadAccountChanged',
}
const stageKeys = { options: 'downloadOptionsFailed', directory: 'downloadDirectoryFailed', prepare: 'downloadPrepareFailed', confirm: 'downloadConfirmFailed' }

function bytes(value) {
  if (!Number.isFinite(value)) return ''
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`
}

/** Compose the AFP download setup and explicit confirmation inside the project Modal.
 * @param {object} React Client React runtime.
 * @param {object} UI Project modal, form and loading primitives.
 * @param {object} icons Existing project glyphs.
 * @param {Function} t Locale lookup.
 * @param {object} store Profile-local download state and operations.
 * @param {Function} ImagePreview Existing same-origin image preview component.
 * @returns {Function} Download dialog with scoped loading, retry and credit confirmation.
 */
export function createAfpDownloadDialog(React, UI, icons, t, store, ImagePreview) {
  const h = React.createElement, { Modal, Button, Input, Tag, Checkbox, StateDot, Menu, Tooltip } = UI
  const Selector = createAfpSelector(React, UI, icons.IconChevronDownOutlineRegular)
  const icon = (name, size = 16) => icons[name] ? h(icons[name], { size }) : null
  const spinner = () => h(StateDot, { state: 'ongoing', size: 14 })
  const tooltip = (label, child) => Tooltip ? h(Tooltip, { label, side: 'top', portal: true }, child) : child

  return function DownloadDialog({ state, onAccount, onTasks }) {
    const [prefix, setPrefix] = React.useState(''), [suffix, setSuffix] = React.useState(''), [confirmed, setConfirmed] = React.useState(false)
    const [bulkOpen, setBulkOpen] = React.useState(false)
    const [directoryPath, setDirectoryPath] = React.useState('')
    const open = state.collectionAction === 'download'
    React.useEffect(() => {
      if (open) { setPrefix(''); setSuffix(''); setConfirmed(false); setBulkOpen(false); void store.loadDownloadOptions({ reset: true }) }
    }, [open])
    React.useEffect(() => setConfirmed(false), [state.downloadPlan?.confirmation])
    React.useEffect(() => { if (!open || state.downloadOptionsLoading || state.downloadBusy) setBulkOpen(false) }, [open, state.downloadOptionsLoading, state.downloadBusy])
    React.useEffect(() => { setDirectoryPath(state.downloadDirectoryListing?.path ?? '') }, [state.downloadDirectoryListing?.path])
    if (!Modal || !open) return null
    if (state.downloadBrowsing) {
      const listing = state.downloadDirectoryListing
      const cancel = () => { if (!state.downloadBusy) store.set({ downloadBrowsing: false, downloadDirectoryListing: null, downloadError: '', downloadErrorStage: '' }) }
      return h(Modal, { open: true, title: t('downloadBrowseTitle'), closeLabel: t('close'), onClose: cancel,
        className: 'afp-wb-action-modal', footer: h('div', { className: 'afp-wb-download-footer-actions' },
          h(Button, { variant: 'ghost', disabled: state.downloadBusy, onClick: cancel }, t('cancelDownloadSetup')),
          h(Button, { variant: 'primary', disabled: state.downloadBusy || !listing, onClick: () => { void store.pickDownloadDirectory(listing.path) } }, t('downloadUseDirectory'))) },
        h('p', { className: 'afp-wb-download-hint' }, t('downloadHostDirectory')),
        h('div', { className: 'afp-wb-directory-path' },
          h(Input, { value: directoryPath, 'aria-label': t('downloadDirectoryPath'), 'data-modal-autofocus': true, disabled: state.downloadBusy,
            onChange: event => setDirectoryPath(event.target.value), onKeyDown: event => { if (event.key === 'Enter' && directoryPath.trim()) void store.browseDownloadDirectory(directoryPath.trim()) } }),
          h(Button, { variant: 'outline', disabled: state.downloadBusy || !directoryPath.trim(), onClick: () => { void store.browseDownloadDirectory(directoryPath.trim()) } }, t('downloadBrowseOpen'))),
        state.downloadError ? h('p', { role: 'alert', className: 'afp-wb-download-hint' }, t('downloadDirectoryFailed')) : null,
        state.downloadBusy ? h('div', { role: 'status' }, spinner(), t('loading')) : null,
        listing ? h(React.Fragment, null,
          h('nav', { className: 'afp-wb-directory-crumbs', 'aria-label': t('downloadDirectoryPath') }, ...listing.crumbs.map(crumb => h(Button, {
            key: crumb.path, variant: 'ghost', size: 'sm', disabled: state.downloadBusy, onClick: () => { void store.browseDownloadDirectory(crumb.path) } }, crumb.name))),
          h('div', { className: 'afp-wb-directory-list' }, ...listing.entries.map(entry => h(Button, { key: entry.path, variant: 'ghost',
            disabled: state.downloadBusy, onClick: () => { void store.browseDownloadDirectory(entry.path) } }, icon('IconFolderCloseRegular'), entry.name))),
          listing.truncated ? h('p', { role: 'status' }, t('downloadDirectoryTruncated')) : null) : null)
    }
    const close = () => { if (!state.downloadBusy) store.set({ collectionAction: null, downloadPlan: null, downloadQuoteChanged: false }) }
    const navigate = callback => { close(); callback?.() }
    const photos = Object.values(state.selectedPhotos), options = state.downloadOptions?.photos ?? []
    const writeEnabled = state.status?.features?.includes('write')
    const chosen = options.flatMap(photo => {
      const rendition = photo.renditions?.find(row => row.id === state.downloadSelected[photo.id] && row.available)
      return rendition ? [{ photo, rendition }] : []
    })
    const ready = Boolean(state.downloadOptions) && !state.downloadOptionsLoading && state.downloadErrorStage !== 'options'
    const hasQuote = ready && chosen.length > 0
    const plan = state.downloadPlan, balance = state.downloadOptions?.creditBalance
    const total = plan?.totalCost ?? chosen.reduce((sum, item) => sum + item.rendition.purchaseCost, 0)
    const paidBlocked = total > 0 && (!writeEnabled || balance == null || total > balance)
    const disabled = state.downloadBusy || !ready || !state.downloadDirectory || !chosen.length || paidBlocked
    const retry = () => { void store.loadDownloadOptions() }
    const bulkChoices = downloadQualityChoices(photos.map(photo => options.find(row => row.id === photo.id) ?? { id: photo.id, renditions: [] }), Boolean(writeEnabled))
    const bulkDisabled = state.downloadBusy || !ready || !bulkChoices.some(choice => !choice.disabled)
    const uniformQuality = chosen.length === photos.length && new Set(chosen.map(item => item.rendition.quality)).size === 1 ? chosen[0]?.rendition.quality : null
    const bulkItems = bulkChoices.map(choice => ({ id: choice.id, disabled: choice.disabled,
      label: h('span', { className: 'afp-wb-download-bulk-choice' }, h('span', null, choice.labelKey ? t(choice.labelKey) : choice.quality),
        h(Tag, { tone: 'quiet' }, `${choice.matched}/${choice.total}`)) }))
    if (bulkItems.length > 2) bulkItems.splice(2, 0, { type: 'separator', id: 'qualities' })
    const bulkMenu = h(Menu, { open: bulkOpen && !bulkDisabled, portal: true, compact: true, autoFocus: true,
      selectedId: bulkChoices.find(choice => choice.quality === uniformQuality)?.id,
      items: bulkItems, onClose: () => setBulkOpen(false),
      onSelect: id => { const choice = bulkChoices.find(row => row.id === id); if (choice && !choice.disabled && !bulkDisabled) store.applyDownloadQuality(choice.preference); setBulkOpen(false) },
      anchor: tooltip(t('bulkQualityTitle'), h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-download-toolbar-button', disabled: bulkDisabled,
        'aria-label': t('bulkQualityTitle'), 'aria-haspopup': 'menu', 'aria-expanded': bulkOpen && !bulkDisabled,
        onClick: () => setBulkOpen(value => !value) }, icon('IconSlidersTwoOutlineRegular', 18))) })
    const changeName = (setter, value) => { setter(value); store.set({ downloadPlan: null }) }
    const warning = state.downloadQuoteChanged ? t('downloadQuoteChanged')
      : total > 0 && !writeEnabled ? t('downloadPaidDisabled')
        : total > 0 && balance == null ? t('downloadBalanceRequired')
          : total > 0 && total > balance ? t('downloadInsufficientCredit') : ''
    const error = state.downloadError ? t(errorKeys[state.downloadError] ?? stageKeys[state.downloadErrorStage] ?? 'downloadOptionsFailed') : ''
    const errorRetry = state.downloadErrorStage === 'options' || state.downloadError === 'download-options-expired'
    const rows = photos.map(source => {
      const photo = options.find(row => row.id === source.id)
      const selected = photo?.renditions?.find(row => row.id === state.downloadSelected[source.id])
      const failed = photo?.errorCode
      const pending = !photo && (state.downloadOptionsLoading || !options.length && !state.downloadError)
      const choices = [{ value: '', label: t('chooseRendition'), disabled: true }, ...(photo?.renditions ?? []).map(row => ({
        value: row.id, disabled: !row.available || row.purchaseCost > 0 && !writeEnabled,
        label: [row.quality, row.width && row.height ? `${row.width}×${row.height}` : '', bytes(row.sizeInBytes),
          row.purchaseCost ? `${row.purchaseCost} ${t('credits')}` : t(row.alreadyAvailable ? 'alreadyAvailable' : 'free')].filter(Boolean).join(' · '),
      }))]
      const title = source.title || photo?.title || source.id
      return h('div', { key: source.id, className: 'afp-wb-download-item', role: 'listitem', 'data-loading': pending },
        h('div', { className: 'afp-wb-download-thumbnail', 'aria-hidden': true }, h(ImagePreview, { photo: source, retry: false })),
        h('div', { className: 'afp-wb-download-item-name' }, tooltip(title, h('span', { className: 'afp-wb-download-item-title' }, title)),
          h('div', { className: 'afp-wb-download-item-meta' },
            h('span', { className: 'afp-wb-download-meta-content', 'aria-hidden': pending },
            selected ? h('span', null, [selected.width && selected.height ? `${selected.width} × ${selected.height}` : '', bytes(selected.sizeInBytes)].filter(Boolean).join(' · ')) : null,
            selected ? h(Tag, { tone: selected.purchaseCost ? 'warning' : 'success' }, selected.purchaseCost ? `${selected.purchaseCost} ${t('credits')}` : t('free')) : null),
            h('span', { className: 'afp-wb-download-placeholder afp-wb-download-meta-placeholder', 'aria-hidden': true }))),
        h('div', { className: 'afp-wb-download-item-quality' },
          h('div', { className: 'afp-wb-download-quality-content', 'aria-hidden': pending, inert: pending ? '' : undefined }, failed
          ? h('span', { className: 'afp-wb-download-item-error' }, t(errorKeys[failed] ?? 'downloadPhotoFailed'))
          : h(Selector, { value: state.downloadSelected[source.id] ?? '', displayValue: selected?.quality ?? t('chooseRendition'),
            label: `${t('downloadQuality')} · ${title}`, options: choices,
            disabled: state.downloadBusy || !ready || !photo, onChange: value => store.setDownloadRendition(source.id, value) })),
          h('span', { className: 'afp-wb-download-placeholder afp-wb-download-quality-placeholder', 'aria-hidden': true })))
    })
    const notice = (message, tone, children, role = 'status') => h('div', { className: `afp-wb-download-notice is-${tone}`, role },
      h('span', null, message), children)
    const previews = chosen.slice(0, 3).map(({ photo }) => h('code', { key: photo.id }, downloadFilenameBase({ guid: photo.guid, photoId: photo.id }, prefix, suffix)))
    return h(Modal, { open, headless: true, title: t('downloadSelectionTitle'), onClose: close, className: 'afp-wb-action-modal afp-wb-download-modal' },
      h('header', { className: 'afp-wb-download-header' },
        h('span', { className: 'afp-wb-download-heading-icon', 'aria-hidden': true }, icon('IconDownloadOutlineRegular', 20)),
        h('div', null, h('h2', null, t('downloadSelectionTitle')), h('p', null, t('downloadDefaultQuality'))),
        h(Tag, null, t('photoCountShort').replace('{count}', String(photos.length))),
        h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-download-close afp-wb-close-button', 'aria-label': t('close'), disabled: state.downloadBusy, onClick: close }, icon('IconCloseOutlineRegular', 14))),
      h('div', { className: 'afp-wb-download-scroll' },
        h('section', { className: 'afp-wb-download-quality-section', 'aria-label': t('downloadQuality') },
          h('div', { className: 'afp-wb-download-section-title' },
            h('div', { className: 'afp-wb-download-section-label' }, h('h3', null, t('downloadQuality')),
              state.downloadBulkResult ? tooltip(state.downloadBulkResult.matched < state.downloadBulkResult.total ? t('bulkQualityUnmatched') : t('bulkQualityTitle'),
                h('span', { role: 'status', className: 'afp-wb-download-bulk-result' },
                  h(Tag, { tone: state.downloadBulkResult.matched < state.downloadBulkResult.total ? 'warning' : 'quiet' },
                    t('bulkQualityApplied').replace('{count}', String(state.downloadBulkResult.matched)).replace('{total}', String(state.downloadBulkResult.total))))) : null),
            h('div', { className: 'afp-wb-download-toolbar-actions' }, bulkMenu,
              tooltip(t('refreshOptions'), h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-download-toolbar-button',
                'aria-label': t('refreshOptions'), disabled: state.downloadBusy || state.downloadOptionsLoading, onClick: retry,
                'aria-busy': state.downloadOptionsLoading }, state.downloadOptionsLoading ? spinner() : icon('IconRefreshOutlineRegular', 18))))),
          error ? notice(error, 'error', h('div', { className: 'afp-wb-download-notice-actions' },
            errorRetry ? h(Button, { variant: 'outline', size: 'sm', disabled: state.downloadBusy || state.downloadOptionsLoading,
              'aria-busy': state.downloadOptionsLoading, icon: state.downloadOptionsLoading ? spinner() : null, onClick: retry }, t('retry')) : null,
            state.downloadError === 'download-auth-unavailable' ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => navigate(onAccount) }, t('openAccountSettings')) : null,
            state.downloadErrorStage === 'confirm' ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => navigate(onTasks) }, t('viewDownloadTasks')) : null), 'alert') : null,
          // 加载与成功共用行、缩略图和滚动容器，只过渡尚未返回的报价字段。
          h('div', { className: 'afp-wb-download-items', role: 'list', 'aria-label': t('downloadQuality'), 'aria-busy': Boolean(state.downloadOptionsLoading) }, ...rows),
          ready && chosen.length < photos.length ? notice(t('downloadAvailableCount').replace('{count}', String(chosen.length)).replace('{total}', String(photos.length)), 'warning',
            h(Button, { variant: 'ghost', size: 'sm', disabled: state.downloadBusy, onClick: retry }, t('retry'))) : null,
          ready && !writeEnabled && options.some(photo => photo.renditions?.some(row => row.purchaseCost > 0)) ? h('p', { className: 'afp-wb-download-hint' }, t('downloadPaidDisabled')) : null),
        h('div', { className: 'afp-wb-download-settings' },
        h('section', { className: 'afp-wb-download-save-section', 'aria-label': t('saveLocation') },
          h('div', { className: 'afp-wb-download-location' },
            h('span', { 'aria-hidden': true }, icon('IconFolderCloseRegular', 18)),
            h('div', null, h('span', { className: 'afp-wb-download-label' }, t('saveLocation')), h('strong', null, state.downloadDirectory?.label ?? t('downloadChooseLocation'))),
            h(Button, { variant: 'outline', size: 'sm', 'data-modal-autofocus': true, disabled: state.downloadBusy,
              'aria-busy': state.downloadBusyStage === 'directory', icon: state.downloadBusyStage === 'directory' ? spinner() : null,
              onClick: () => { void store.pickDownloadDirectory() } }, t(state.downloadBusyStage === 'directory' ? 'choosingDirectory' : state.downloadDirectory ? 'changeDirectory' : 'chooseDirectory'))),
          h('details', { className: 'afp-wb-download-filename' },
            h('summary', null, h('span', null, t('filenameCustomization')), h('span', null, t(prefix || suffix ? 'downloadCustomizedName' : 'downloadOriginalName')), icon('IconChevronDownOutlineRegular', 14)),
            h('div', { className: 'afp-wb-download-filename-fields' },
              h('div', { className: 'afp-wb-download-naming' },
                h('label', null, t('filenamePrefix'), h(Input, { className: 'afp-wb-input', value: prefix, maxLength: 80, placeholder: t('filenamePrefixExample'), disabled: state.downloadBusy,
                  onChange: event => changeName(setPrefix, event.target.value) })),
                h('label', null, t('filenameSuffix'), h(Input, { className: 'afp-wb-input', value: suffix, maxLength: 80, placeholder: t('filenameSuffixExample'), disabled: state.downloadBusy,
                  onChange: event => changeName(setSuffix, event.target.value) }))),
              previews.length ? h('div', { className: 'afp-wb-download-name-preview' }, h('span', null, t('filenamePreview')), ...previews) : null,
              h('p', { className: 'afp-wb-download-hint' }, t('downloadFilenameHint'))))),
        warning ? notice(warning, 'warning') : null,
        plan ? h('section', { className: 'afp-wb-download-review', 'aria-label': t('downloadConfirmation') },
          h(Tag, { tone: 'success' }, t('downloadReviewed').replace('{count}', String(plan.items.length))),
          total > 0 ? h(Checkbox, { checked: confirmed, label: t('confirmDownloadSpend').replace('{credits}', String(total)), disabled: state.downloadBusy, onChange: setConfirmed })
            : h('span', null, t('downloadFreeConfirmed'))) : null)),
      h('footer', { className: 'afp-wb-download-footer' },
        h('div', { className: 'afp-wb-download-total' }, h('span', null, t('totalCreditCost')),
          h('strong', null, hasQuote ? String(total) : '—'), h('span', null, hasQuote ? t('credits') : t('downloadQuotePending')),
          h('small', null, `${t('creditBalance')} · ${balance ?? t('notAvailable')}`)),
        h('div', { className: 'afp-wb-download-footer-actions' }, h(Button, { variant: 'ghost', disabled: state.downloadBusy, onClick: close }, t('cancelDownloadSetup')),
          h(Button, { variant: 'primary', disabled: disabled || Boolean(plan && total > 0 && !confirmed),
            'aria-busy': ['prepare', 'confirm'].includes(state.downloadBusyStage),
            icon: ['prepare', 'confirm'].includes(state.downloadBusyStage) ? spinner() : icon('IconDownloadOutlineRegular'),
            onClick: () => { void (plan ? store.confirmDownload() : store.prepareDownload({ prefix, suffix })) } },
          t(state.downloadBusyStage === 'prepare' ? 'checkingDownload' : state.downloadBusyStage === 'confirm' ? 'submittingDownload' : plan ? 'downloadStartBackground' : 'previewDownload')))))
  }
}
