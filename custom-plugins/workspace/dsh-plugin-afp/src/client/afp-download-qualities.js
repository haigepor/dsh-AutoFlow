function rank(left, right) {
  return (right.width ?? 0) * (right.height ?? 0) - (left.width ?? 0) * (left.height ?? 0)
    || (right.sizeInBytes ?? 0) - (left.sizeInBytes ?? 0) || left.purchaseCost - right.purchaseCost
}

/** Match one eligible rendition per photo without sharing opaque rendition IDs.
 * @param {object[]} photos Safe Host photo quotes.
 * @param {object} preference Free, highest, or exact AFP quality-label selection.
 * @param {boolean} writeEnabled Whether paid renditions may be selected.
 * @returns {object} Photo IDs mapped to their own matching rendition IDs; unmatched photos are omitted.
 */
export function chooseDownloadRenditions(photos, preference, writeEnabled) {
  return Object.fromEntries(photos.flatMap(photo => {
    if (photo.errorCode) return []
    const eligible = (photo.renditions ?? []).filter(row => row.available && (row.purchaseCost === 0 || writeEnabled)
      && (preference.kind !== 'free' || row.purchaseCost === 0)
      && (preference.kind !== 'quality' || row.quality === preference.quality))
    const chosen = eligible.sort(rank)[0]
    return chosen ? [[photo.id, chosen.id]] : []
  }))
}

/** Describe batch menu choices with counts including unavailable photos.
 * @param {object[]} photos Safe Host photo quotes.
 * @param {boolean} writeEnabled Whether paid renditions may be selected.
 * @returns {object[]} Presets and exact AFP quality choices with matching counts and disabled states.
 */
export function downloadQualityChoices(photos, writeEnabled) {
  const qualities = [...new Set(photos.flatMap(photo => (photo.renditions ?? []).map(row => row.quality).filter(Boolean)))]
  return [{ id: 'free', labelKey: 'bulkQualityFree', preference: { kind: 'free' } },
    { id: 'highest', labelKey: 'bulkQualityHighest', preference: { kind: 'highest' } },
    ...qualities.map((quality, index) => ({ id: `quality:${index}`, quality, preference: { kind: 'quality', quality } }))]
    .map(choice => { const matched = Object.keys(chooseDownloadRenditions(photos, choice.preference, writeEnabled)).length
      return { ...choice, matched, total: photos.length, disabled: !matched } })
}
