/** The final Session menu action hides an idle row from this browser's sidebar without changing its log. */
import { IconTrashOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DismissSessionInjected, SessionMenuItemProps } from '../contract/slots.ts'

/** Menu row (order 500): hide an idle Session from the local sidebar and offer Undo in the shared notice. */
export function DismissSessionMenuItem({
  canDismiss, sessionId, useMenuOpenState, dismissSession, t,
}: SessionMenuItemProps<DismissSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      disabled={!canDismiss}
      separatorBefore
      icon={<IconTrashOutlineRegular />}
      onSelect={() => {
        if (!canDismiss) return
        setMenuOpen(false)
        dismissSession(sessionId)
      }}
    >
      {t(canDismiss ? 'menu.dismissSession' : 'menu.dismissSessionBusy')}
    </MenuItemButton>
  )
}
