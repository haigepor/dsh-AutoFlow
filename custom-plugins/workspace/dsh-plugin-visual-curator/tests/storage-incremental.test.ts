/** Authoritative records use the existing storage domain while the legacy unit remains read-only. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { storageFixture as fixture } from './helpers/storage-fixture.ts'

test('new and edited records survive reopen without rewriting the legacy unit', async () => {
  const f = await fixture()
  try {
    const base = await f.legacy()
    const original = await f.domain(base).createStyle({ operationId: 'old-style', name: 'Original' }, f.actor)
    await base.close()
    const before = await readFile(f.path, 'utf8')
    let opened = await f.open()
    const input = { operationId: 'new-style', name: 'Incremental' }
    const created = await f.domain(opened.repository).createStyle(input, f.actor)
    await f.domain(opened.repository).saveDraft({ operationId: 'edit-original', styleId: original.id, expectedRevision: 1, rules: [], referenceIds: [], feedbackIds: [], conflicts: [] }, f.actor)
    assert.ok(await readFile(f.path, 'utf8') === before, 'small writes must not serialize and replace the legacy file')
    await opened.close()
    opened = await f.open()
    assert.equal(opened.repository.get('style', original.id)?.revision, 2)
    assert.equal((await f.domain(opened.repository).createStyle(input, f.actor)).id, created.id)
    assert.equal(opened.repository.list('style').length, 2)
    await opened.close()
  } finally { await f.cleanup() }
})

test('a failed incremental manifest hides its dependencies and the same operation can retry after reopen', async () => {
  const f = await fixture()
  let fail = false
  const openUnit = f.backend.kv.open
  f.backend.kv.open = async descriptor => {
    const unit = await openUnit(descriptor), put = unit.putRecord.bind(unit)
    unit.putRecord = async (table, key, value) => { if (fail && table === 'manifests') { fail = false; throw new Error('Injected manifest failure') }; return put(table, key, value) }
    return unit
  }
  try {
    let opened = await f.open()
    const input = { operationId: 'retry-style', name: 'Retry' }
    fail = true
    await assert.rejects(f.domain(opened.repository).createStyle(input, f.actor), { code: 'storage-commit-failed' })
    assert.equal(opened.repository.list('style').length, 0)
    await opened.close()
    opened = await f.open()
    assert.equal(opened.repository.list('style').length, 0)
    await f.domain(opened.repository).createStyle(input, f.actor)
    assert.equal(opened.repository.list('style').length, 1)
    await opened.close()
  } finally { await f.cleanup() }
})

test('a legacy writer changing the frozen base is rejected instead of mixing incompatible records', async () => {
  const f = await fixture()
  try {
    const base = await f.legacy()
    await f.domain(base).createStyle({ operationId: 'seed', name: 'Seed' }, f.actor); await base.close()
    const opened = await f.open(); await opened.close()
    const oldWriter = await f.legacy()
    await f.domain(oldWriter).createStyle({ operationId: 'old-binary-write', name: 'Changed base' }, f.actor); await oldWriter.close()
    await assert.rejects(f.open(), { code: 'reference-unavailable' })
  } finally { await f.cleanup() }
})
