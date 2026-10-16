/** Native dropdown and disclosure compositions for workbench-only fields. */

/** Compose controls without introducing another component library. @param {object} React Shared runtime. @param {object} ui Native primitives. @returns {object} Controls. */
export function createControls(React, ui) {
  const h = React.createElement
  function Select({ label, value, options, onChange, disabled }) {
    const [open, setOpen] = React.useState(false)
    const id = React.useId()
    return h('div', { className: 'ai-field' }, h('span', { id }, label), h(ui.Menu, { open, portal: true, selectedId: value, autoFocus: true,
      items: options.map(option => ({ id: option.value, label: option.label })), onClose: () => setOpen(false),
      onSelect: selected => { onChange(selected); setOpen(false) },
      anchor: h(ui.Button, { className: 'ai-dropdown', variant: 'outline', size: 'sm', disabled, 'aria-labelledby': id, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(!open) },
        h('span', null, options.find(option => option.value === value)?.label), h(ui.IconChevronDownOutlineRegular, { size: 14 })) }))
  }
  function Disclosure({ title, children, initialOpen = false, className = '' }) {
    const [open, setOpen] = React.useState(initialOpen), id = React.useId()
    return h('section', { className: `ai-disclosure ${className}`, 'data-open': open },
      h(ui.Button, { variant: 'ghost', className: 'ai-disclosure-trigger', 'aria-expanded': open, 'aria-controls': id, onClick: () => setOpen(!open) },
        h('span', null, title), h(ui.IconChevronDownOutlineRegular, { size: 14 })),
      h(ui.AnimatedCollapse, { open, id, keepMounted: true, contentClassName: 'ai-disclosure-body' }, children))
  }
  function ActionsMenu({ label, items }) {
    const [open, setOpen] = React.useState(false)
    return h(ui.Menu, { open, portal: true, items: items.map(({ run, ...item }) => item), onClose: () => setOpen(false),
      onSelect: id => { setOpen(false); items.find(item => item.id === id)?.run() },
      anchor: h(ui.Button, { variant: 'ghost', size: 'sm', className: 'ai-icon-button', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(!open) }, h(ui.IconEllipsisOutlineRegular, { size: 16 })) })
  }
  return { Select, Disclosure, ActionsMenu }
}
