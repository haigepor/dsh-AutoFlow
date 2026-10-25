import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { suggestionSchema } from '../src/shared/model.ts'

class ObservedAdapter extends MemoryDomainAdapter {
  recordReads = 0
  manifestReads = 0
  override readRecord(key: string) { this.recordReads++; return super.readRecord(key) }
  override manifests() { this.manifestReads++; return super.manifests() }
  resetReads(): void { this.recordReads = 0; this.manifestReads = 0 }
}

function suggestion(text = 'Saved content') {
  return suggestionSchema.parse({ schemaVersion: 1, profileId: 'snapshot-profile', createdAt: '2026-10-25T00:00:00.000Z', kind: 'suggestion', id: 'suggestion-one', status: 'pending', author: { kind: 'agent', sourceId: 'fixture' }, text, feedbackIds: [] })
}

function setup() {
  const adapter = new ObservedAdapter()
  const repository = new DomainRepository('snapshot-profile', adapter)
  const commit = async (expectedRevision: number, operationId: string, text = 'Saved content') => repository.commit({ aggregateId: 'suggestions', expectedRevision, operationId, request: { text }, records: [suggestion(text)], state: { id: 'suggestion-one' } })
  return { adapter, repository, commit }
}

test('one synchronous read scope verifies each record once and returns independent clones from get and list', async () => {
  const { adapter, repository, commit } = setup()
  try {
    await commit(0, 'initial')
    adapter.resetReads()
    const result = repository.readSnapshot(() => {
      const first = repository.get('suggestion', 'suggestion-one')
      const second = repository.list('suggestion')[0]
      const third = repository.get('suggestion', 'suggestion-one')
      assert.ok(first && second && third)
      assert.equal(adapter.recordReads, 1)
      assert.equal(adapter.manifestReads, 1)
      assert.notEqual(first, second)
      assert.notEqual(second, third)
      assert.notEqual(first.feedbackIds, second.feedbackIds)
      first.text = 'Local read mutation'
      first.feedbackIds.push('local-only')
      assert.equal(second.text, 'Saved content')
      assert.deepEqual(third.feedbackIds, [])
      const manifest = repository.manifest('suggestions')
      assert.ok(manifest)
      manifest.records.length = 0
      assert.equal(repository.manifests()[0]?.records.length, 1)
      return second.text
    })
    assert.equal(result, 'Saved content')
    assert.equal(adapter.recordReads, 1)
  } finally { await repository.close() }
})

test('nested read scopes share a snapshot and an exception releases only the scope that owns it', async () => {
  const { adapter, repository, commit } = setup()
  try {
    await commit(0, 'initial')
    adapter.resetReads()
    const failure = new Error('Projection failed')
    repository.readSnapshot(() => {
      assert.ok(repository.get('suggestion', 'suggestion-one'))
      assert.throws(() => repository.readSnapshot(() => { repository.list('suggestion'); throw failure }), error => error === failure)
      assert.equal(repository.get('suggestion', 'suggestion-one')?.text, 'Saved content')
    })
    assert.equal(adapter.recordReads, 1)
    assert.equal(adapter.manifestReads, 1)
    assert.throws(() => repository.readSnapshot(() => { repository.get('suggestion', 'suggestion-one'); throw failure }), error => error === failure)
    assert.equal(adapter.recordReads, 2)
    repository.readSnapshot(() => assert.equal(repository.get('suggestion', 'suggestion-one')?.text, 'Saved content'))
    assert.equal(adapter.recordReads, 3)
    assert.equal(adapter.manifestReads, 3)
  } finally { await repository.close() }
})

test('the next read scope observes a newly committed revision rather than the previous projection cache', async () => {
  const { adapter, repository, commit } = setup()
  try {
    await commit(0, 'initial')
    repository.readSnapshot(() => assert.equal(repository.get('suggestion', 'suggestion-one')?.text, 'Saved content'))
    await commit(1, 'updated', 'New committed content')
    adapter.resetReads()
    repository.readSnapshot(() => {
      assert.equal(repository.get('suggestion', 'suggestion-one')?.text, 'New committed content')
      assert.equal(repository.list('suggestion')[0]?.text, 'New committed content')
    })
    assert.equal(adapter.recordReads, 1)
    assert.equal(adapter.manifestReads, 1)
    assert.equal(repository.manifest('suggestions')?.revision, 2)
  } finally { await repository.close() }
})

test('a later projection detects externally changed physical content after a previous successful read', async () => {
  const { adapter, repository, commit } = setup()
  try {
    await commit(0, 'initial')
    repository.readSnapshot(() => assert.ok(repository.get('suggestion', 'suggestion-one')))
    const [key, record] = [...adapter.records.entries()][0]!
    assert.ok(record.kind === 'suggestion')
    adapter.records.set(key, { ...record, text: 'Changed without a committed manifest' })
    assert.throws(() => repository.readSnapshot(() => repository.get('suggestion', 'suggestion-one')), { code: 'reference-unavailable' })
    adapter.records.set(key, record)
    assert.equal(repository.readSnapshot(() => repository.get('suggestion', 'suggestion-one'))?.text, 'Saved content')
  } finally { await repository.close() }
})

test('a failed manifest keeps physical dependencies invisible to read scopes until the original commit succeeds', async () => {
  const { adapter, repository, commit } = setup()
  try {
    adapter.failNextManifest = true
    await assert.rejects(commit(0, 'retryable'), { code: 'storage-commit-failed' })
    assert.equal(adapter.records.size, 1)
    repository.readSnapshot(() => {
      assert.equal(repository.get('suggestion', 'suggestion-one'), undefined)
      assert.deepEqual(repository.list('suggestion'), [])
      assert.equal(repository.manifest('suggestions'), undefined)
    })
    await commit(0, 'retryable')
    assert.equal(repository.readSnapshot(() => repository.get('suggestion', 'suggestion-one'))?.text, 'Saved content')
  } finally { await repository.close() }
})

test('absence in an empty read scope does not hide a record published before the next scope', async () => {
  const { repository, commit } = setup()
  try {
    repository.readSnapshot(() => {
      assert.equal(repository.get('suggestion', 'suggestion-one'), undefined)
      assert.deepEqual(repository.list('suggestion'), [])
    })
    await commit(0, 'now-present')
    assert.equal(repository.readSnapshot(() => repository.get('suggestion', 'suggestion-one'))?.text, 'Saved content')
    assert.equal(repository.get('suggestion', 'suggestion-one')?.text, 'Saved content')
  } finally { await repository.close() }
})
