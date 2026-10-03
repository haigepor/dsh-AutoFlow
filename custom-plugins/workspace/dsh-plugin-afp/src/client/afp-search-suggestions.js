const normalized = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim()

/** Match ordinary terms and curated aliases locally; category filtering never alters the actual search.
 * @param {Array} catalog Generated positive keyword rows.
 * @param {string} query Input text.
 * @param {string} [category] Category key or an empty string for all categories.
 * @returns {Array} At most ten ranked recommendation rows.
 */
export function suggestKeywords(catalog, query, category = '') {
  const needle = normalized(query), rows = catalog.filter(row => !category || row.categories.includes(category))
  if (!needle) {
    if (category) return rows.slice(0, 10)
    const chosen = new Map()
    for (const key of ['animals', 'food', 'landscape', 'movie-poster', 'celestial-body-wallpaper']) {
      for (const row of rows.filter(item => item.categories.includes(key)).slice(0, 2)) chosen.set(row.id, row)
    }
    return [...chosen.values()]
  }
  const exact = catalog.find(row => [row.term, ...row.aliases].some(value => normalized(value) === needle))
  return rows.map((row, index) => {
    const values = [row.term, ...row.aliases].map(normalized)
    const rank = values.includes(needle) ? 0 : exact?.related.includes(row.id) ? 1
      : values.some(value => value.startsWith(needle)) ? 2 : values.some(value => value.split(/\s+/).some(word => word.startsWith(needle))) ? 3
        : values.some(value => value.includes(needle)) ? 4 : Infinity
    return { row, rank, index }
  }).filter(item => Number.isFinite(item.rank)).sort((a, b) => a.rank - b.rank || a.index - b.index).slice(0, 10).map(item => item.row)
}

/** Decide input-owned navigation without submitting while an IME composition is active.
 * @param {object} event Keyboard event fields.
 * @param {number} index Active option or -1.
 * @param {number} count Available options.
 * @param {boolean} open Menu visibility.
 * @returns {object} Action and next active index.
 */
export function suggestionKey(event, index, count, open) {
  if (event.isComposing || event.keyCode === 229) return { action: 'none', index }
  if (event.key === 'Escape' && open) return { action: 'close', index: -1 }
  if (count && event.key === 'ArrowDown') return { action: 'navigate', index: open ? (index + 1) % count : 0 }
  if (count && event.key === 'ArrowUp') return { action: 'navigate', index: open && index >= 0 ? (index - 1 + count) % count : count - 1 }
  if (event.key === 'Enter') return { action: open && index >= 0 && index < count ? 'pick' : 'submit', index }
  return { action: 'none', index }
}

/** Fit a portaled menu to its input and the visible window, preferring below when it fits.
 * @param {object} rect Input wrapper rectangle.
 * @param {number} width Viewport width.
 * @param {number} height Viewport height.
 * @param {number} [topMargin] Platform titlebar clearance plus menu margin.
 * @param {number} [contentHeight] Measured menu height, capped by the viewport.
 * @returns {object} Fixed-position coordinates and available height.
 */
export function placeSuggestions(rect, width, height, topMargin = 8, contentHeight = 380) {
  const menuWidth = Math.min(rect.width, Math.max(0, width - 16)), below = Math.max(0, height - rect.bottom - 12)
  const above = Math.max(0, rect.top - topMargin - 4), wanted = Math.min(380, contentHeight)
  const down = below >= wanted || below >= above
  return { position: 'fixed', left: Math.max(8, Math.min(rect.left, width - menuWidth - 8)), width: menuWidth,
    top: down ? rect.bottom + 4 : Math.max(topMargin, rect.top - Math.min(wanted, above) - 4), maxHeight: down ? Math.min(380, below) : Math.min(380, above) }
}
