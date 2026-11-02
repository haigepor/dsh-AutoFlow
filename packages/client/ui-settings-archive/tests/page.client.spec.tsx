// @vitest-environment jsdom
/** Slow deletion keeps its progress visible above the page mask. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { ArchivePage } from '../src/client/ArchivePage.tsx'
import type { ArchivePageProps } from '../src/client/contract.ts'
import { ArchiveOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('shows completed and total deletions in the confirmation dialog while a request is pending', async () => {
  const ids = [SessionId('alpha'), SessionId('beta')]
  const sessions = createSnapshotStore<SessionListState>({ phase: 'ready', ids,
    byId: Object.fromEntries(ids.map(id => [id, {
      id, title: id, displayTitle: id, blank: false, running: false, updatedAt: 1, retainedBy: {},
    }])),
    projectionsBySession: {},
  })
  let finish: (() => void) | undefined
  const operations = new ArchiveOperations({
    change: () => new Promise<void>((resolve) => { finish = resolve }),
    archived: () => true, title: id => id, favorite: async () => {}, prepareOpen: () => () => {},
  })
  const props = {
    useSessions: bindSnapshotSelector(sessions),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore({ phase: 'ready', state: 'idle', error: null, items: [], archivedSessionIds: ids, pinnedSessionIds: [] })),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore(new Map())),
    useOperation: bindSnapshotSelector(operations.state),
    useFavorites: bindSnapshotSelector(createSnapshotStore({ value: { favoriteSessionIds: [] }, status: 'ready', writable: true })),
    useSessionAccess: () => true, canChange: () => true, canDelete: () => true,
    run: operations.run.bind(operations), favorite: operations.favorite.bind(operations), retry: operations.retry.bind(operations),
    dismissResult: () => {}, dismissNotice: () => {}, refresh: async () => {}, open: () => {}, t: makeTranslate(en),
  } as ArchivePageProps
  render(<ArchivePage {...props} />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select current results' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
  const dialog = screen.getByRole('dialog', { name: 'Permanently delete sessions' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }))
  try {
    expect(within(dialog).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
    expect(within(dialog).getByRole('progressbar').getAttribute('aria-valuemax')).toBe('2')
    await act(async () => { finish?.() })
    expect(within(dialog).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
    expect(within(dialog).getByRole('status').textContent).toContain('1/2')
  } finally {
    await act(async () => { finish?.() })
    operations.dispose()
  }
})
