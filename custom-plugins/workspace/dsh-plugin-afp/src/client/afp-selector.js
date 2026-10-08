/** Compose localized AFP choices with the project Menu and Button primitives.
 * @param {object} React React client runtime.
 * @param {object} UI Existing DSH primitives.
 * @param {Function} [Chevron] Project dropdown icon.
 * @returns {Function} Controlled choice component with a portaled menu and optional compact display value.
 */
export function createAfpSelector(React, { Menu, Button }, Chevron) {
  const h = React.createElement
  return function AfpSelector({ value, options, label, onChange, disabled = false, className = '', displayValue }) {
    const [open, setOpen] = React.useState(false)
    const trigger = React.useRef(null)
    const chosen = options.find(option => option.value === value)
    return h('div', { className: `afp-wb-selector ${className}` }, h(Menu, {
      open: open && !disabled, onClose: () => setOpen(false), portal: true, compact: true, autoFocus: true,
      listClassName: 'afp-wb-selector-menu', getAnchorRect: () => trigger.current?.getBoundingClientRect() ?? null,
      selectedId: chosen ? String(options.indexOf(chosen)) : undefined,
      items: options.map((option, index) => ({ id: String(index), label: option.label, disabled: option.disabled })),
      onSelect: id => { const option = options[Number(id)]; if (option && !option.disabled) onChange(option.value); setOpen(false) },
      anchor: h(Button, { ref: trigger, variant: 'outline', size: 'sm', className: 'afp-wb-selector-trigger', disabled,
        'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': open && !disabled,
        onClick: () => setOpen(current => !current) },
      h('span', { className: 'afp-wb-selector-value' }, displayValue ?? chosen?.label ?? label), Chevron ? h(Chevron, { size: 14 }) : null),
    }))
  }
}
