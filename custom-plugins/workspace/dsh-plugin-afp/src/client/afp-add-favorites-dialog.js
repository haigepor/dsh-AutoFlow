/** Compose a snapshot-based add dialog using existing AFP previews and project controls.
 * @param {object} React React runtime.
 * @param {object} UI Project dialog and form primitives.
 * @param {object} icons Existing folder and search glyphs.
 * @param {Function} t Localized text lookup.
 * @param {object} store Shared AFP state.
 * @param {Function} ImagePreview Shared cached preview component.
 * @returns {Function} Add-to-collection confirmation dialog.
 */
export function createAfpAddFavoritesDialog(React, UI, icons, t, store, ImagePreview) {
  const h = React.createElement, { Modal, Input, Button, Tag, StateDot } = UI
  return function AfpAddFavoritesDialog({ state }) {
    const [query, setQuery] = React.useState(''), [targetId, setTargetId] = React.useState('')
    const request = state.favoritesRequest, region = state.regions.collections, result = state.favoritesResult
    React.useEffect(() => { setQuery(''); setTargetId('') }, [request])
    if (!request || !Modal) return null
    const collections = (region.data?.items ?? []).filter(item => item.name?.trim() && !item.readOnly)
    const filtered = collections.filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase()))
    const target = collections.find(item => item.id === targetId)
    const allowed = state.status?.features?.includes('write') && state.status?.features?.includes('read')
    const disabled = !target || !allowed || state.busy || state.favoritesBusy || region.loading || Boolean(region.error)
    const text = (key, count) => t(key).replace('{count}', String(count))
    const close = () => store.closeAddFavorites()
    const completed = (result?.items ?? []).filter(row => row.status === 'completed')
    const detailed = completed.every(row => ['added', 'already-present'].includes(row.membershipChange))
    return h(Modal, { open: true, title: t('addFavorites'), closeLabel: t('close'), onClose: close,
      className: 'afp-wb-action-modal afp-wb-add-favorites-modal', contentClassName: 'afp-wb-action-modal-content',
      footer: h('div', { className: 'afp-wb-dialog-footer' },
        h(Button, { variant: 'ghost', disabled: state.favoritesBusy, onClick: close }, t(result ? 'close' : 'cancelConfirmation')),
        !result ? h(Button, { variant: 'primary', disabled, 'aria-busy': state.favoritesBusy,
          icon: state.favoritesBusy ? h(StateDot, { state: 'ongoing', size: 14 }) : icons.IconFolderOpenOutlineRegular ? h(icons.IconFolderOpenOutlineRegular, { size: 16 }) : null,
          onClick: () => { void store.addFavorites(targetId) } }, t(state.favoritesBusy ? 'addingFavorites' : 'confirmAddFavorites')) : null) },
      h('div', { className: 'afp-wb-add-selection-summary' },
        h('div', { className: 'afp-wb-add-thumbnails', 'aria-hidden': true }, ...request.photos.slice(0, 4).map(photo => h(ImagePreview, { key: photo.id, photo }))),
        h('div', null, h('strong', null, text('selectedPhotoCount', request.photos.length)), h('p', null, t('addFavoritesHelp')))),
      !result ? h('div', { className: 'afp-wb-add-targets' },
        h(Input, { className: 'afp-wb-input', value: query, placeholder: t('filterCollections'), 'aria-label': t('filterCollections'),
          disabled: state.favoritesBusy, onChange: event => setQuery(event.target.value),
          icon: icons.IconSearchOutlineRegular ? h(icons.IconSearchOutlineRegular, { size: 16 }) : null }),
        region.loading ? h('div', { className: 'afp-wb-add-skeleton', role: 'status', 'aria-label': t('loading') },
          ...Array.from({ length: 3 }, (_, index) => h('span', { key: index, className: 'afp-skeleton' }))) : null,
        region.error ? h('div', { className: 'afp-wb-error-row', role: 'alert' }, t('regionReadFailed'),
          h(Button, { variant: 'ghost', disabled: region.loading || state.favoritesBusy, onClick: () => { void store.loadCollections() } }, t('retry'))) : null,
        h('div', { className: 'afp-wb-add-target-list', role: 'group', 'aria-label': t('targetCollection') }, ...filtered.map(item =>
          h(Button, { key: item.id, variant: 'ghost', className: `afp-wb-add-target${targetId === item.id ? ' is-selected' : ''}`,
            disabled: state.favoritesBusy || region.loading, 'aria-pressed': targetId === item.id, onClick: () => setTargetId(item.id) },
            icons.IconFolderOpenOutlineRegular ? h(icons.IconFolderOpenOutlineRegular, { size: 18 }) : null,
            h('span', { className: 'afp-wb-add-target-name' }, item.name), h(Tag, { tone: 'info' }, t('private')),
            h(Tag, { tone: 'quiet' }, item.count == null ? '—' : String(item.count))))),
        !region.loading && !region.error && !filtered.length ? h('p', { className: 'afp-wb-subtle' }, t(collections.length ? 'noMatchingCollections' : 'noWritableCollections')) : null,
        target ? h('p', { className: 'afp-wb-subtle' }, `${t('targetCollection')}: ${target.name}`) : null,
        !allowed ? h('p', { className: 'afp-wb-error-row', role: 'alert' }, t('favoritesPermissionsRequired')) : null) : null,
      state.favoritesError ? h('p', { className: 'afp-wb-error-row', role: 'alert' }, t('favoritesWriteUncertain')) : null,
      result ? h('div', { className: 'afp-wb-add-result', role: 'status' },
        h('div', { className: 'afp-wb-add-result-tags' },
          detailed ? h(React.Fragment, null, h(Tag, { tone: 'success' }, text('favoritesAdded', completed.filter(row => row.membershipChange === 'added').length)),
            h(Tag, { tone: 'quiet' }, text('favoritesExisting', completed.filter(row => row.membershipChange === 'already-present').length)))
            : h(Tag, { tone: 'success' }, text('favoritesCompleted', result.completed)),
          h(Tag, { tone: result.failed ? 'warning' : 'quiet' }, text('favoritesFailed', result.failed ?? 0)),
          h(Tag, { tone: result.pending ? 'warning' : 'quiet' }, text('favoritesPending', result.pending ?? 0))),
        (result.items ?? []).some(row => row.status !== 'completed') ? h('p', null, t('favoritesPartialHelp')) : null,
        ...(result.items ?? []).filter(row => row.status !== 'completed').map(row => h('div', { key: row.photoId, className: 'afp-wb-add-result-row' },
          h('span', null, row.title || request.photos.find(photo => photo.id === row.photoId)?.title || row.photoId),
          h(Tag, { tone: 'warning' }, t(row.status === 'pending' ? 'favoritesPendingLabel' : 'failed'))))) : null)
  }
}
