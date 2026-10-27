/** A second Host cannot recover or mutate the first Host's active task history. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { acquireTaskWriter, openImageTaskRepository } from '../src/host/tasks/repository.ts'

test('task writer remains exclusive until release and can be acquired again afterwards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autoflow-codex-writer-'))
  try {
    const lockPath = join(directory, 'tasks')
    const release = await acquireTaskWriter(lockPath)
    await assert.rejects(acquireTaskWriter(lockPath))
    await release()
    const next = await acquireTaskWriter(lockPath)
    await next()
    await assert.rejects(openImageTaskRepository({ open: async () => { throw new Error('An invalid spec must never open storage') } }, 'invalid-domain-name', lockPath))
    const afterInvalid = await acquireTaskWriter(lockPath)
    await afterInvalid()
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  }
})
