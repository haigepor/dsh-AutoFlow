/** Admission and committed-failure reports are independent of the settings surface. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionDeletion } from '../src/deletion.ts'
import { SessionErasureError } from '@deepseek-ai/dsh-session-persistence'
import { expect, it, onTestFinished, vi } from 'vitest'

function setup() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const id = SessionId('selected')
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }
  const erase = vi.fn(async () => true)
  const retire = vi.fn(async () => {})
  const recover = vi.fn(async () => {})
  const remove = vi.fn(async () => {})
  const detach = vi.fn(async () => {})
  const unpin = vi.fn(async () => [])
  const unarchive = vi.fn(async () => [])
  const reconcile = vi.fn(async () => [])
  const registry = { archivedSessionIds: [id], unpinSession: unpin, unarchiveSession: unarchive,
    list: () => [{ sessionIds: [id], detachSession: detach }] }
  ctx.provide('sessionErasure', { erase })
  ctx.provide('sessionPersistence', { stat: async () => ({ header }) } as never)
  ctx.provide('sessions', { get: () => undefined } as never)
  ctx.provide('sessionProjectionCache', { remove } as never)
  ctx.provide('sessionQuery', { listSessions: reconcile } as never)
  ctx.provide('workspaceRegistry', registry as never)
  const owner: Pick<ApiSessionAgentController, 'withDeletion'> = { withDeletion: async (_id, run) => run(retire) }
  const service = new SessionDeletion(ctx, { owner, recover })
  return { ctx, id, header, service, registry, erase, retire, recover, remove, detach, unpin, unarchive, reconcile }
}

it('retires before erasing, then clears the checkpoint, membership, pins and search index', async () => {
  const test = setup()
  test.erase.mockImplementation(async () => { expect(test.retire).toHaveBeenCalledTimes(1); return true })
  await expect(test.service.deleteSession({ sessionId: test.id })).resolves.toEqual({ deleted: true })
  expect(test.remove).toHaveBeenCalledWith(test.id, test.header)
  expect(test.detach).toHaveBeenCalledWith(test.id)
  expect(test.unpin).toHaveBeenCalledWith(test.id)
  expect(test.unarchive).toHaveBeenCalledWith(test.id)
  expect(test.reconcile).toHaveBeenCalledTimes(1)
})

it('publishes committed removal before slower list cleanup can reclassify the row as unarchived', async () => {
  const test = setup()
  let release: (() => void) | undefined
  const removed = vi.fn()
  test.ctx.on('api-session/removed', removed)
  test.remove.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
  const deletion = test.service.deleteSession({ sessionId: test.id })
  try {
    await vi.waitFor(() => { expect(test.remove).toHaveBeenCalledOnce() })
    expect(removed).toHaveBeenCalledWith(test.id)
  } finally {
    release?.()
    await deletion
  }
})

it('refuses an unarchived record or active work before retirement or physical deletion', async () => {
  const test = setup()
  test.registry.archivedSessionIds = []
  await expect(test.service.deleteSession({ sessionId: test.id })).rejects.toMatchObject({ code: 'sessionDeletion/not-archived' })
  test.registry.archivedSessionIds = [test.id]
  test.ctx.on('workspace/session-activity', async (_request, next) => [{ kind: 'turn', sessionId: test.id }, ...await next()])
  await expect(test.service.deleteSession({ sessionId: test.id })).rejects.toMatchObject({ code: 'sessionDeletion/active' })
  expect(test.retire).not.toHaveBeenCalled()
  expect(test.erase).not.toHaveBeenCalled()
})

it('restores list metadata after an uncommitted failure and reports committed cleanup for retry', async () => {
  const test = setup()
  test.erase.mockRejectedValueOnce(new Error('permission denied'))
  await expect(test.service.deleteSession({ sessionId: test.id })).rejects.toMatchObject({ code: 'sessionDeletion/failed' })
  expect(test.recover).toHaveBeenCalledWith(test.id)
  expect(test.remove).not.toHaveBeenCalled()
  test.erase.mockRejectedValueOnce(new SessionErasureError(test.id, true, new Error('cleanup failed')))
  await expect(test.service.deleteSession({ sessionId: test.id })).rejects.toMatchObject({ code: 'sessionDeletion/cleanup-failed' })
  expect(test.remove).toHaveBeenCalledWith(test.id, test.header)
  await expect(test.service.deleteSession({ sessionId: test.id })).resolves.toEqual({ deleted: true })
})
