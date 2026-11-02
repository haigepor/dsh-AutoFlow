/** Batch behavior is observable through Host commands, item reports and navigation. */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ArchiveDeleteError, ArchiveOperations, type ArchiveCommands } from '../src/client/operations.ts'

const sid = (id: string) => id as SessionId
function setup() {
  const archived = new Set<SessionId>()
  const opened: SessionId[] = []
  const commands: ArchiveCommands = {
    change: vi.fn<ArchiveCommands['change']>(async (operation, id) => {
      if (operation === 'archive') archived.add(id)
      else archived.delete(id)
    }),
    favorite: vi.fn(async () => {}),
    prepareOpen: vi.fn<ArchiveCommands['prepareOpen']>(id => () => { opened.push(id) }),
    archived: id => archived.has(id), title: id => `Title ${id}`,
  }
  return { commands, archived, opened, operations: new ArchiveOperations(commands) }
}

describe('archive settings batches', () => {
  it('deletes each confirmed target and retries committed cleanup even after archive membership is gone', async () => {
    const { operations, commands } = setup()
    vi.mocked(commands.change).mockRejectedValueOnce(new ArchiveDeleteError('cleanupFailure'))
    await operations.run('delete', [sid('one'), sid('two')])
    expect(operations.state.getSnapshot().result).toEqual({ operation: 'delete', success: 1,
      failures: [{ id: 'one', title: 'Title one', reason: 'cleanupFailure' }] })
    await operations.retry()
    expect(vi.mocked(commands.change).mock.calls.map(call => call[1])).toEqual(['one', 'two', 'one'])
    expect(operations.state.getSnapshot().notice).toMatchObject({ key: 'deleteDone', success: true })
  })
  it('continues after an active-session refusal, deduplicates and retries only the unfinished target', async () => {
    const { commands, archived, operations } = setup()
    const refusal = Object.assign(new Error('active'), { name: 'WorkspaceArchiveError', rpcError: { code: 'workspace/session-active' } })
    vi.mocked(commands.change).mockRejectedValueOnce(refusal)
    await operations.run('archive', [sid('active'), sid('quiet'), sid('quiet')])
    expect([...archived]).toEqual(['quiet'])
    expect(operations.state.getSnapshot().result).toEqual({ operation: 'archive', success: 1,
      failures: [{ id: 'active', title: 'Title active', reason: 'activeFailure' }] })
    await operations.retry()
    expect([...archived]).toEqual(['quiet', 'active'])
    expect(vi.mocked(commands.change).mock.calls.map(call => call[1])).toEqual(['active', 'quiet', 'active'])
    expect(operations.state.getSnapshot().notice).toMatchObject({ key: 'archiveDone', count: 1, success: true })
  })

  it('waits for restoration before opening and never opens a failed restore', async () => {
    const { operations, archived, opened, commands } = setup()
    archived.add(sid('one'))
    let finish: (() => void) | undefined
    vi.mocked(commands.change).mockImplementationOnce(async (_operation, id) => {
      await new Promise<void>((resolve) => { finish = resolve })
      archived.delete(id)
    })
    const restoring = operations.run('restore', [sid('one')], sid('one'))
    expect(opened).toEqual([])
    finish?.()
    await restoring
    expect(opened).toEqual(['one'])
    archived.add(sid('two'))
    vi.mocked(commands.change).mockRejectedValueOnce(new Error('offline'))
    await operations.run('restore', [sid('two')], sid('two'))
    expect(opened).toEqual(['one'])
    expect(operations.state.getSnapshot().result?.failures[0]?.reason).toBe('operationFailure')
  })

  it('serializes targets, refuses overlapping batches and stops subsequent dispatches on disposal', async () => {
    const { operations, commands } = setup()
    let finish: (() => void) | undefined
    vi.mocked(commands.change).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const batch = operations.run('archive', [sid('one'), sid('two')])
    await operations.run('archive', [sid('other')])
    expect(commands.change).toHaveBeenCalledTimes(1)
    expect(operations.state.getSnapshot().progress).toEqual({ done: 0, total: 2 })
    operations.dispose()
    finish?.()
    await batch
    expect(commands.change).toHaveBeenCalledTimes(1)
    expect(operations.state.getSnapshot().notice).toBeNull()
  })

  it('accepts already restored state without another mutation and reports failed favorite writes', async () => {
    const { operations, commands, opened } = setup()
    await operations.run('restore', [sid('restored')], sid('restored'))
    expect(commands.change).not.toHaveBeenCalled()
    expect(opened).toEqual(['restored'])
    vi.mocked(commands.favorite).mockRejectedValueOnce(new Error('offline'))
    await operations.favorite(sid('restored'), true)
    expect(operations.state.getSnapshot().notice).toMatchObject({ key: 'favoriteFailed', success: false })
    operations.dismissNotice()
    expect(operations.state.getSnapshot().notice).toBeNull()
  })
})
