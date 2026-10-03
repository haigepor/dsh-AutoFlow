import catalog from './afp-search-catalog.json' with { type: 'json' }
import { suggestKeywords, suggestionKey, placeSuggestions } from './afp-search-suggestions.js'

/** Compose an input-owned combobox with the project's menu surface and portal runtime.
 * @param {object} React React runtime.
 * @param {object} UI Project Input, Button, Tag, MenuSurface and portal helpers.
 * @param {object} icons Existing project icons.
 * @param {Function} t Locale lookup.
 * @returns {Function} Controlled ordinary-keyword input with local suggestions.
 */
export function createAfpSearchInput(React, UI, icons, t) {
  const h = React.createElement, { Input, Button, Tag, MenuSurface, createPortal, useDismissOnOutsidePointer } = UI
  return function AfpSearchInput({ value, onChange, enabled = true }) {
    const [open, setOpen] = React.useState(false), [category, setCategory] = React.useState(''), [active, setActive] = React.useState(-1)
    const [position, setPosition] = React.useState(null)
    const root = React.useRef(null), surface = React.useRef(null), composing = React.useRef(false)
    const restoringFocus = React.useRef(false)
    const id = React.useId(), rows = suggestKeywords(catalog, value, category)
    const visible = enabled && open && Boolean(MenuSurface && createPortal)
    React.useEffect(() => { if (!enabled) { setOpen(false); setActive(-1) } }, [enabled])
    useDismissOnOutsidePointer?.(root, visible, setOpen, surface)
    React.useLayoutEffect(() => {
      if (!visible) return
      const update = () => {
        if (!root.current) return
        const clearance = Number.parseFloat(getComputedStyle(root.current).getPropertyValue('--dsh-frame-top-clearance')) || 0
        const next = placeSuggestions(root.current.getBoundingClientRect(), window.innerWidth, window.innerHeight, clearance + 8, surface.current?.scrollHeight || 380)
        setPosition(next)
      }
      update()
      window.addEventListener('resize', update)
      document.addEventListener('scroll', update, true)
      const resize = new ResizeObserver(update)
      resize.observe(root.current)
      return () => { resize.disconnect(); window.removeEventListener('resize', update); document.removeEventListener('scroll', update, true) }
    }, [visible, value, category])
    React.useEffect(() => { setActive(-1) }, [value, category])
    React.useEffect(() => { if (visible && active >= 0) surface.current?.querySelector(`#${CSS.escape(`${id}-option-${active}`)}`)?.scrollIntoView({ block: 'nearest' }) }, [active, visible, id])
    const focusInput = () => {
      // 从 Portal 恢复焦点时不重新打开刚收起的菜单。
      restoringFocus.current = true
      root.current?.querySelector('input')?.focus()
      restoringFocus.current = false
    }
    const pick = row => { onChange(row.term); setActive(-1); setOpen(false); focusInput() }
    const keydown = event => {
      const result = suggestionKey({ key: event.key, keyCode: event.keyCode, isComposing: composing.current || event.nativeEvent?.isComposing }, active, rows.length, visible)
      if (result.action === 'none') { if (event.key === 'Enter' && (composing.current || event.nativeEvent?.isComposing || event.keyCode === 229)) event.preventDefault(); return }
      if (result.action === 'submit') { setOpen(false); return }
      event.preventDefault()
      if (result.action === 'navigate') { setOpen(true); setActive(result.index) }
      if (result.action === 'close') { event.stopPropagation(); setOpen(false); setActive(-1) }
      if (result.action === 'pick') pick(rows[result.index])
    }
    const popup = visible ? h(MenuSurface, { ref: surface, compact: true, className: 'afp-wb-search-suggestions',
      style: position ?? { visibility: 'hidden', position: 'fixed', top: 0, left: 0 },
      onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); focusInput() } } },
      h('div', { className: 'afp-wb-suggestion-heading' }, h('span', null, t('keywordSuggestions')), h(Tag, { tone: 'quiet' }, t('skillKeywords'))),
      h('div', { className: 'afp-wb-suggestion-categories', 'aria-label': t('suggestionCategories') },
        ...['', 'animals', 'food', 'landscape', 'movie-poster', 'celestial-body-wallpaper'].map(key => h(Button, {
          key, type: 'button', size: 'sm', variant: category === key ? 'outline' : 'ghost', 'aria-pressed': category === key,
          onMouseDown: event => event.preventDefault(), onClick: () => { setCategory(key); setActive(-1) } }, t(key || 'allCategories')))),
      h('div', { id: `${id}-list`, role: 'listbox', 'aria-label': t('keywordSuggestions'), className: 'afp-wb-suggestion-list' },
        ...rows.map((row, index) => h('div', { id: `${id}-option-${index}`, key: row.id, role: 'option', 'aria-selected': active === index,
          className: `afp-wb-suggestion-row${active === index ? ' is-active' : ''}`, onMouseEnter: () => setActive(index),
          onMouseDown: event => event.preventDefault(), onClick: () => pick(row) },
          h('div', null, h('span', { className: 'afp-wb-suggestion-term' }, row.term),
            row.aliases.length ? h('span', { className: 'afp-wb-suggestion-aliases' }, row.aliases.join(' · ')) : null),
          h(Tag, { tone: 'quiet' }, row.categories.map(t).join(' · '))))),
      !rows.length ? h('p', { className: 'afp-wb-suggestion-empty', role: 'status' }, t('noKeywordSuggestions')) : null,
      h('p', { className: 'afp-wb-suggestion-hint' }, t('keywordSuggestionHint'))) : null
    return h('div', { className: 'afp-wb-search-input-slot', ref: root,
      onBlur: event => { if (!root.current?.contains(event.relatedTarget) && !surface.current?.contains(event.relatedTarget)) setOpen(false) } },
      h(Input, { className: 'afp-wb-input afp-wb-search-input', value, placeholder: t('query'), 'aria-label': t('query'),
        role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': visible, 'aria-controls': visible ? `${id}-list` : undefined,
        'aria-activedescendant': visible && active >= 0 && active < rows.length ? `${id}-option-${active}` : undefined,
        autoComplete: 'off', icon: icons.IconSearchOutlineRegular ? h(icons.IconSearchOutlineRegular, { size: 16 }) : null,
        onFocus: () => { if (!restoringFocus.current) setOpen(true) }, onChange: event => { onChange(event.target.value); setActive(-1); setOpen(true) }, onKeyDown: keydown,
        onCompositionStart: () => { composing.current = true }, onCompositionEnd: () => { composing.current = false } }),
      popup ? createPortal(popup, document.body) : null)
  }
}
