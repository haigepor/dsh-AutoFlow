/** @jsxRuntime classic */
/** @jsx React.createElement */
/** Shared native menu-backed selection for workbench forms and portaled dialogs. */

/** @param React Shell React. @param ui Existing primitives. @returns Stable field component using the shared Menu. */
export function createSelectField(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Menu, Button } = ui
  return function SelectField({ label, value, options, disabled = false, onChange }: {
    label: string; value: string; options: readonly { value: string; label: string }[]; disabled?: boolean; onChange(value: string): void
  }) {
    const [open, setOpen] = React.useState(false)
    return <Menu className="vc-select" open={open} onClose={() => setOpen(false)} portal compact autoFocus selectedId={value}
      items={options.map(option => ({ id: option.value, label: option.label, disabled }))}
      onSelect={next => { setOpen(false); onChange(next) }}
      anchor={<Button className="vc-select-trigger" variant="outline" disabled={disabled} aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(current => !current)} onKeyDown={event => { if (!open && event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}>
        <span>{options.find(option => option.value === value)?.label ?? label}</span><ui.IconChevronDownOutlineRegular size={12} />
      </Button>} />
  }
}
