/** Settings-specific glyphs supplement the shared navigation icon library. */
import {
  IconAgentPresetOutlineMedium, IconArchiveOutlineMedium, IconPersonalizationOutlineMedium,
  IconSettingsOutlineMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** @param props - owning section id. @returns A monochrome 16px navigation glyph. */
export function SettingsNavIcon({ id }: { id: string }) {
  if (id === 'account') return <IconUserOutlineMedium size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutlineMedium size={16} />
  if (id === 'plugins') return <IconPersonalizationOutlineMedium size={16} />
  if (id === 'archived-sessions') return <IconArchiveOutlineMedium size={16} />
  if (id === 'models') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="5" width="14" height="14" rx="3" /><rect x="9" y="9" width="6" height="6" rx="1" />
    <path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3M19 9h3m-3 6h3" />
  </svg>
  if (id === 'appearance-theme') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3c-.7-.8-.1-2.2 1-2.2H18a3 3 0 0 0 3-3A9.5 9.5 0 0 0 12 3Z" />
    <circle cx="7.5" cy="10" r=".8" /><circle cx="11" cy="7" r=".8" /><circle cx="15.5" cy="8" r=".8" /><circle cx="6.5" cy="14.5" r=".8" />
  </svg>
  if (id === 'market' || id === 'plugin-market') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4 4-2 6a3 3 0 0 0 5 2 3 3 0 0 0 5 0 3 3 0 0 0 5 0 3 3 0 0 0 5-2l-2-6H4ZM4 13v7h16v-7M9 20v-5h6v5M8 4l-1 6m9-6 1 6M12 4v6" />
  </svg>
  if (id === 'afp-workbench') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 3-3 6 6" />
  </svg>
  return <IconSettingsOutlineMedium size={16} />
}
