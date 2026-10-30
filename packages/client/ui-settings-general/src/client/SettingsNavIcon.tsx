/** Settings-specific glyphs supplement the shared navigation icon library. */
import {
  IconAgentPresetOutlineMedium,
  IconArchiveOutlineMedium,
  IconPersonalizationOutlineMedium,
  IconSettingsOutlineMedium,
  IconUserOutlineMedium,
  IconSkillOutlineMedium,
  IconDataOutlineMedium,
  IconLightOutlineMedium,
  IconAppsAddOutlineMedium,
  LinkIconMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** @param props - owning section id. @returns A monochrome 16px navigation glyph. */
export function SettingsNavIcon({ id }: { id: string }) {
  if (id === 'skills') return <IconSkillOutlineMedium size={16} />
  if (id === 'mcp') return <IconSettingsOutlineMedium size={16} />
  if (id === 'account') return <IconUserOutlineMedium size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutlineMedium size={16} />
  if (id === 'plugins') return <IconPersonalizationOutlineMedium size={16} />
  if (id === 'archived-sessions') return <IconArchiveOutlineMedium size={16} />
  if (id === 'models') return <IconDataOutlineMedium size={16} />
  if (id === 'appearance-theme') return <IconLightOutlineMedium size={16} />
  if (id === 'market' || id === 'plugin-market') return <IconAppsAddOutlineMedium size={16} />
  if (id === 'afp-workbench') return <LinkIconMedium kind="image" size={16} />
  return <IconSettingsOutlineMedium size={16} />
}
