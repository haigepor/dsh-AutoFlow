import type { IconProps } from './icons/props.ts'
import css from './TaskStatusIcon.module.css'

/** Read-only task lifecycle glyph with reduced-motion aware ongoing feedback. */
export interface TaskStatusIconProps extends IconProps {
  /** Recorded task state; color is supplied by the owning task row. */
  state: 'completed' | 'in_progress' | 'pending'
}

/**
 * Render a checkbox, rotating progress ring, or check on the same SVG grid.
 * @param props - Task state and optional size/class; default edge is 16px.
 * @returns A decorative SVG; the owning row supplies localized status text.
 */
export function TaskStatusIcon({ state, size = 16, className }: TaskStatusIconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true" data-task-state={state}>
      {state !== 'in_progress' && <rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.3" />}
      {state === 'completed' && <path d="m4.8 8 2.1 2.1 4.3-4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
      {state === 'in_progress' && (
        <>
          <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.3" opacity="0.2" />
          <g className={css.motion}>
            <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.5"
              strokeDasharray="22 15" strokeLinecap="round" transform="rotate(-90 8 8)" />
          </g>
        </>
      )}
    </svg>
  )
}
