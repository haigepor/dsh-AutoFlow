// Switch: two-state toggle. `label` is required and has no default, so a render
// site cannot ship the control without an accessible name.

import clsx from 'clsx'
import { StateDot } from './StateDot.tsx'
import css from './Switch.module.css'

/**
 * Render a toggle switch.
 * @param props.checked - the current state; the control is fully controlled.
 * @param props.onChange - called with the state the click asks for.
 * @param props.label - localized accessible name, owned by the render site.
 * @param props.disabled - whether the control refuses input; owners also set it
 * while a write is in flight, not only when a deployment locks the toggle.
 * @param props.loading - replaces the track and thumb with shared progress while locking input; layout and checked state stay controlled.
 * @param props.title - localized hover text, typically why the toggle is locked.
 * @param props.className - extra class for layout placement.
 * @returns the switch element.
 */
export function Switch({ checked, onChange, label, disabled = false, loading = false, title, className }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  loading?: boolean
  title?: string | undefined
  // `| undefined` so a caller can forward an optional class straight through
  // under exactOptionalPropertyTypes (a CSS-module lookup is string|undefined).
  className?: string | undefined
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled || loading}
      aria-busy={loading}
      data-loading={loading}
      className={clsx(css.switch, className)}
      onClick={() => { onChange(!checked) }}
    >
      <span className={css.thumb} aria-hidden="true">
        <span className={css.progress}>
          {loading ? <StateDot state="ongoing" size={16} className={css.progressIcon} /> : null}
        </span>
      </span>
    </button>
  )
}
