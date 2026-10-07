/** Shared decorative illustrations for built-in and custom preset cards. */
import type { ReactNode } from 'react'
import standard from './assets/standard-whale-maid-v6.webp'
import ptc from './assets/ptc-whale-maid-v6.webp'
import minimal from './assets/minimal-whale-maid-v6.webp'
import cordis from './assets/cordis-whale-maid-v6.webp'
import css from './AgentPresetSection.module.css'

const illustrations = { standard, ptc, minimal, cordis }

/** Render a transparent preset illustration without adding to the card's accessible name.
 * @param props Preset identity; custom presets share the workshop illustration.
 * @returns A fixed-size decorative image with asynchronous decoding.
 */
export function PresetIllustration({ id }: { id: string }): ReactNode {
  const kind = id === 'standard' || id === 'ptc' || id === 'minimal' ? id : 'cordis'
  return <img className={css.illustration} data-preset-art={kind} src={illustrations[kind]}
    width={112} height={112} alt="" aria-hidden="true" draggable={false} decoding="async" />
}
