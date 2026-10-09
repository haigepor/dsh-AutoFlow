import type { IconProps } from './icons/props.ts'

/** Read-only task lifecycle glyph; historical progress never implies a live animation. */
export interface TaskStatusIconProps extends IconProps {
  /** Recorded task state; color is supplied by the owning task row. */
  state: 'completed' | 'in_progress' | 'pending'
}

/**
 * Render a shared checkbox, progress arc, or check on the same SVG grid.
 * @param props - Task state and optional size/class; default edge is 16px.
 * @returns A decorative SVG; the owning row supplies localized status text.
 */
export function TaskStatusIcon({ state, size = 16, className }: TaskStatusIconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true" data-task-state={state}>
      <rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.3" />
      {state === 'completed' && <path d="m4.8 8 2.1 2.1 4.3-4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
      {state === 'in_progress' && (
        <>
          <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" opacity="0.25" />
          <path d="M8 5a3 3 0 0 1 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="8" r="0.7" fill="currentColor" />
        </>
      )}
    </svg>
  )
}
