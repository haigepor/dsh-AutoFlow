/** Miniature interface artwork for the two built-in palettes. */
import type { ThemeSet } from '../../theme-settings.ts'
import css from '../ThemeSettingsPage.module.css'

/**
 * Draw palette-specific interface colors using the theme-owned preview aliases.
 * @param props.palette - built-in palette shown independently of the active choice.
 * @returns decorative, resolution-independent interface artwork.
 */
export function PalettePreview({ palette }: { palette: ThemeSet }) {
  return <svg className={css.palettePreview} data-preview-palette={palette}
    viewBox="0 0 160 82" fill="none" aria-hidden="true">
    <rect width="160" height="82" rx="7" fill="var(--preview-canvas)" />
    <path d="M7 0h35v82H7a7 7 0 0 1-7-7V7a7 7 0 0 1 7-7Z" fill="var(--preview-sidebar)" />
    <rect x="8" y="10" width="8" height="8" rx="2" fill="var(--preview-accent)" />
    <rect x="20" y="11" width="14" height="3" rx="1.5" fill="var(--preview-accent)" opacity=".55" />
    <rect x="8" y="28" width="26" height="8" rx="3" fill="var(--preview-accent)" opacity=".18" />
    <path d="M12 32h16M9 44h22M9 53h17M9 62h20" stroke="var(--preview-accent)" strokeWidth="2" strokeLinecap="round" opacity=".55" />
    <rect x="52" y="11" width="46" height="4" rx="2" fill="var(--preview-accent)" />
    <rect x="52" y="22" width="94" height="18" rx="5" fill="var(--preview-panel)" />
    <path d="M59 28h52M59 34h36" stroke="var(--preview-accent)" strokeWidth="2" strokeLinecap="round" opacity=".3" />
    <rect x="52" y="46" width="94" height="24" rx="5" fill="var(--preview-panel)" />
    <rect x="59" y="52" width="46" height="3" rx="1.5" fill="var(--preview-accent)" opacity=".35" />
    <rect x="119" y="57" width="18" height="7" rx="3.5" fill="var(--preview-accent)" />
  </svg>
}
