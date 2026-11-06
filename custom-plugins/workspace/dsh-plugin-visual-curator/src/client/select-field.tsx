/** @jsxRuntime classic */
/** @jsx React.createElement */
/** Shared menu-backed choices with optional HTML form validation. */

/** @param React Shell React. @param ui Existing primitives. @returns Stable field component using the shared Menu. */
export function createSelectField(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Menu, Button } = ui
  return function SelectField({ label, value, options, disabled = false, required = false, validationMessage, onChange }: {
    label: string; value: string; options: readonly { value: string; label: string }[]; disabled?: boolean; required?: boolean; validationMessage?: string; onChange(value: string): void
  }) {
    const [open, setOpen] = React.useState(false), [attempted, setAttempted] = React.useState(false)
    const trigger = React.useRef<HTMLButtonElement>(null), errorId = React.useId()
    const valid = options.some(option => option.value === value && option.value !== ''), invalid = required && attempted && !valid && !disabled
    return <React.Fragment><Menu className="vc-select" open={open} onClose={() => setOpen(false)} portal compact autoFocus selectedId={value}
      items={options.map(option => ({ id: option.value, label: option.label, disabled }))}
      onSelect={next => { setOpen(false); setAttempted(false); onChange(next) }}
      anchor={<Button ref={trigger} className="vc-select-trigger" variant="outline" disabled={disabled} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined}
        onClick={() => setOpen(current => !current)} onKeyDown={event => { if (!open && event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}>
        <span>{options.find(option => option.value === value)?.label ?? label}</span><ui.IconChevronDownOutlineRegular size={12} />
      </Button>} />
      {required && <select hidden tabIndex={-1} aria-hidden="true" aria-label={label} required disabled={disabled} value={valid ? value : ''} onChange={() => {}} onInvalid={event => {
        event.preventDefault(); setAttempted(true)
        if (event.currentTarget.form?.querySelector(':invalid') === event.currentTarget) trigger.current?.focus({ preventScroll: false })
      }}><option value="" />{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}
      {invalid && <small id={errorId} className="vc-field-error" role="alert">{validationMessage ?? label}</small>}
    </React.Fragment>
  }
}
