/** File-family artwork follows the shared plugin glyphs' 36px canvas and fixed blue/mint palette. */
import { useId } from 'react'

/** Filled folder artwork with document-safe gradient identifiers.
 * @returns Decorative inline artwork for filesystem inventory rows.
 */
export function InventoryFileArtwork() {
  const gradient = `inventory-file-${useId().replaceAll(':', '')}`
  return (
    <svg width="32" height="32" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 12a2 2 0 0 1 2-2h5l3 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V12Z" fill="#69B9FF" fillOpacity="0.55" />
      <path d="M10 16h17a1.5 1.5 0 0 1 1.46 1.85l-1.65 7A1.5 1.5 0 0 1 25.35 26H9.5A1.5 1.5 0 0 1 8 24.5v-7A1.5 1.5 0 0 1 9.5 16Z" fill={`url(#${gradient})`} />
      <defs>
        <linearGradient id={gradient} x1="12" y1="16" x2="24" y2="27" gradientUnits="userSpaceOnUse">
          <stop stopColor="#54ECE7" />
          <stop offset="1" stopColor="#658EFF" />
        </linearGradient>
      </defs>
    </svg>
  )
}
