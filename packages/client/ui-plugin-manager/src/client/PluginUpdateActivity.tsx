/** Measured archive progress and ongoing feedback for checks and installation. */
import type { ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PluginUpdateActivity.module.css'

/**
 * @param props - Localized label, optional measured byte percentage and compact presentation.
 * @returns Numeric progress in badges and a measured track in details; checks remain indeterminate.
 */
export function PluginUpdateActivity({ label, percent, compact = false }: {
  readonly label: string
  readonly percent?: number | undefined
  readonly compact?: boolean
}): ReactNode {
  const value = percent === undefined ? undefined : Math.min(100, Math.max(0, Math.floor(percent)))
  const text = <span className={css.label}><StateDot state="ongoing" size={14} /><span>{label}</span>
    {value === undefined ? null : <span className={css.percent} data-plugin-update-percent>{value}%</span>}
  </span>
  if (compact) return text
  return <div className={css.activity} aria-busy="true">
    {text}
    <div className={css.track} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={value} data-plugin-update-progress>
      {value === undefined ? <span className={css.sweep} /> : <span className={css.fill} style={{ width: `${value}%` }} />}
    </div>
  </div>
}
