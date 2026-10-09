/** Shared indeterminate feedback for update installation and Host recovery. */
import type { ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PluginUpdateActivity.module.css'

/**
 * Show ongoing work without implying a measured completion percentage.
 * @param props - Localized activity label and compact inline presentation.
 * @returns Loading label and, outside compact badges, an indeterminate progress track.
 */
export function PluginUpdateActivity({ label, compact = false }: {
  readonly label: string
  readonly compact?: boolean
}): ReactNode {
  const text = <span className={css.label}><StateDot state="ongoing" size={14} /><span>{label}</span></span>
  if (compact) return text
  return <div className={css.activity} aria-busy="true">
    {text}
    <div className={css.track} role="progressbar" aria-label={label} data-plugin-update-progress>
      <span className={css.sweep} />
    </div>
  </div>
}
