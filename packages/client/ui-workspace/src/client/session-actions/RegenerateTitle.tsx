/** Explicit title refresh action; pending state outlives the menu. */
import { IconRefreshOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RegenerateTitleInjected, SessionMenuItemProps } from '../contract/slots.ts'

/**
 * Render one Session title refresh menu entry.
 * @param props - target Session, persistent pending state, action and locale.
 * @returns the menu entry, disabled while its request is active.
 */
export function RegenerateTitleMenuItem({
  sessionId, useTitleGenerating, regenerateTitle, useSessionAccess, t,
}: SessionMenuItemProps<RegenerateTitleInjected>) {
  const pending = useTitleGenerating(ids => ids.has(sessionId))
  const allowed = useSessionAccess(sessionId, 'session/regenerateTitle')
  if (!allowed) return null
  return <MenuItemButton disabled={pending} icon={<IconRefreshOutlineRegular />} onSelect={() => { regenerateTitle(sessionId) }}>
    {t(pending ? 'menu.regeneratingTitle' : 'menu.regenerateTitle')}
  </MenuItemButton>
}
