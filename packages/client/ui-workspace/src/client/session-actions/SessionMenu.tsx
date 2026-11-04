/** Legacy external Session contributions shared by the row, header, and More trigger. */
import { useMemo } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { deriveFlat } from '../tree.ts'

type Props = Pick<PropsRuntime<'contextMenu.content'>, 'target' | 'dismiss' | 'useSessions' | 'useSessionStatus'>
  & PropsRenderSlots<'sidebar.workspaces.session.menu.item'>
/** @param props - captured Session and the existing extension position. @returns legacy component contributions. */
export function SessionMenu({ target, dismiss, renderSlot, useSessions, useSessionStatus }: Props) {
  const hookContext = useMemo<readonly [boolean, (open: boolean) => void]>(() => [true, (open) => { if (!open) dismiss() }], [dismiss])
  const list = useSessions(state => state)
  const statuses = useSessionStatus(state => state)
  if (target.kind !== 'session') return null
  const session = deriveFlat(list, [target.value.sessionId], {
    pinnedSessionIds: [], archivedSessionIds: [], archivedFilter: 'show',
  }, statuses)[0]
  const canDismiss = session !== undefined && !session.running && session.runningSubagentCount === 0
    && session.pendingInteraction === undefined && !session.completed
  return renderSlot('sidebar.workspaces.session.menu.item', { ...target.value, canDismiss }, {
    hookContext,
  })
}
