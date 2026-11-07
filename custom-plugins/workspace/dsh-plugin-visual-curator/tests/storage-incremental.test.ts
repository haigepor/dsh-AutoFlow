/** Authoritative records use the existing storage domain while the legacy unit remains read-only. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir, stat, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { DomainRepository, StorageDomainAdapter, contentDigest, manifestSchema } from '../src/domain/repository.ts'
import { suggestionSchema, type CuratorRecord } from '../src/shared/model.ts'
import { storageFixture as fixture } from './helpers/storage-fixture.ts'

const suggestion = (profileId: string, text: string, id = 'suggestion') => suggestionSchema.parse({ schemaVersion: 1, profileId, createdAt: '2026-11-07T00:00:00.000Z', kind: 'suggestion', id, status: 'pending', author: { kind: 'agent', sourceId: 'fixture' }, text, feedbackIds: [] })
const recordKey = (record: CuratorRecord) => `${record.kind}-${contentDigest(record).slice(10)}`

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

test('only current incremental pointers hydrate on reopen and old content hashes are reused without rewriting files', async () => {
  const f = await fixture(), hydrated: string[] = []
  let recordWrites = 0
  const openUnit = f.backend.kv.open
  f.backend.kv.open = async descriptor => {
    const unit = await openUnit(descriptor)
    if (descriptor.name.endsWith('_delta_v1')) {
      const selected = unit.loadSelected?.bind(unit), put = unit.putRecord.bind(unit)
      assert.ok(selected)
      unit.loadSelected = async selection => { if (Array.isArray(selection.records)) hydrated.push(...selection.records); return selected(selection) }
      unit.putRecord = async (table, key, value) => { if (table === 'records') recordWrites++; return put(table, key, value) }
    }
    return unit
  }
  try {
    let opened = await f.open()
    const first = suggestion(f.profileId, 'First revision'), second = suggestion(f.profileId, 'Second revision')
    await opened.repository.commit({ aggregateId: 'history', expectedRevision: 0, operationId: 'first', request: {}, records: [first], state: {} })
    const independent = opened.repository.get('suggestion', first.id)!
    await opened.repository.commit({ aggregateId: 'history', expectedRevision: 1, operationId: 'second', request: {}, records: [second], state: {} })
    assert.equal(independent.text, 'First revision')
    await opened.close()
    const directory = join(f.root, `${f.source.name}_delta_v1`, 'records'), oldPath = join(directory, `${recordKey(first)}.json`), original = await readFile(oldPath, 'utf8'), originalStat = await stat(oldPath)
    hydrated.length = 0; recordWrites = 0
    opened = await f.open()
    assert.deepEqual(hydrated, [recordKey(second)]); assert.equal(recordWrites, 0)
    assert.equal(opened.repository.get('suggestion', first.id)?.text, 'Second revision')
    await opened.repository.commit({ aggregateId: 'history', expectedRevision: 2, operationId: 'reuse-first', request: {}, records: [first], state: {} })
    assert.equal(recordWrites, 0, 'An unloaded historical content key is hydrated and verified, not overwritten')
    assert.equal(await readFile(oldPath, 'utf8'), original); assert.equal((await stat(oldPath)).mtimeMs, originalStat.mtimeMs)
    assert.equal((await readdir(directory)).filter(file => file.endsWith('.json')).length, 2)
    assert.equal(opened.repository.get('suggestion', first.id)?.text, 'First revision')
    assert.equal(opened.repository.receipt('first')?.revision, 1)
    await opened.close()
  } finally { await f.cleanup() }
})

test('a corrupt orphan is not read on open but is rejected before reusing its old hash; current digest failures remain loud', async () => {
  const f = await fixture()
  try {
    let opened = await f.open()
    const first = suggestion(f.profileId, 'Historical'), second = suggestion(f.profileId, 'Current')
    await opened.repository.commit({ aggregateId: 'history', expectedRevision: 0, operationId: 'first', request: {}, records: [first], state: {} })
    await opened.repository.commit({ aggregateId: 'history', expectedRevision: 1, operationId: 'second', request: {}, records: [second], state: {} }); await opened.close()
    const directory = join(f.root, `${f.source.name}_delta_v1`, 'records'), orphan = join(directory, `${recordKey(first)}.json`), broken = '{"version":1,"record":{"invalid":true}}\n'
    await writeFile(orphan, broken, 'utf8')
    opened = await f.open(); assert.equal(opened.repository.get('suggestion', first.id)?.text, 'Current')
    await assert.rejects(opened.repository.commit({ aggregateId: 'history', expectedRevision: 2, operationId: 'reuse-corrupt', request: {}, records: [first], state: {} }), { code: 'storage-commit-failed' })
    assert.equal(opened.repository.get('suggestion', first.id)?.text, 'Current'); assert.equal(await readFile(orphan, 'utf8'), broken)
    await opened.close()
    const path = join(directory, `${recordKey(second)}.json`), document = JSON.parse(await readFile(path, 'utf8'))
    document.record.text = 'Externally changed current record'; await writeFile(path, `${JSON.stringify(document)}\n`, 'utf8')
    await assert.rejects(f.open(), { code: 'reference-unavailable' })
  } finally { await f.cleanup() }
})

test('releasing replaced manifest candidates preserves shared current keys and another staged unpublished key', async () => {
  const f = await fixture()
  try {
    const base = await f.facility.open(f.source)
    const incremental = await f.facility.open(defineDomain({ name: `${f.source.name}_delta_v1`, version: 1, layout: 'per-record', global: { schema: z.strictObject({ profileId: z.literal(f.profileId), baseDigest: z.string().nullable() }), initial: { profileId: f.profileId, baseDigest: null as string | null } }, tables: { ...f.source.tables, records: { ...f.source.tables.records, loading: 'manual' } } }))
    const adapter = new StorageDomainAdapter(base, incremental), records = incremental.table('records')
    const old = suggestion(f.profileId, 'Old'), replacement = suggestion(f.profileId, 'New'), staged = suggestion(f.profileId, 'Staged', 'staged')
    const manifest = (id: string, revision: number, values: CuratorRecord[]) => manifestSchema.parse({ schemaVersion: 1, profileId: f.profileId, aggregateId: id, revision, records: values.map(value => ({ key: recordKey(value), id: value.id, kind: value.kind, digest: contentDigest(value) })), state: {}, receipts: {} })
    await adapter.writeRecord(recordKey(old), old); await adapter.writeManifest(manifest('target', 1, [old]))
    await adapter.writeManifest(manifest('shared-reference', 1, [old]))
    await adapter.writeRecord(recordKey(staged), staged)
    await adapter.writeRecord(recordKey(replacement), replacement); await adapter.writeManifest(manifest('target', 2, [replacement]))
    assert.equal(records.isLoaded(recordKey(old)), true, 'Another current manifest still refers to this candidate')
    assert.equal(records.isLoaded(recordKey(staged)), true, 'An unrelated unpublished dependency is outside the release candidates')
    await adapter.writeManifest(manifest('shared-reference', 2, []))
    assert.equal(records.isLoaded(recordKey(old)), false); assert.equal(records.isLoaded(recordKey(staged)), true)
    assert.ok([...records.keys()].includes(recordKey(old)), 'Release does not remove the physical historical key')
    await adapter.writeManifest(manifest('staged-publication', 1, [staged]))
    const repository = new DomainRepository(f.profileId, adapter)
    assert.equal(repository.get('suggestion', old.id)?.text, 'New'); assert.equal(repository.get('suggestion', staged.id)?.text, 'Staged')
    await adapter.writeRecord(recordKey(old), old); await adapter.writeManifest(manifest('target', 3, [old]))
    await adapter.writeRecord(recordKey(old), old)
    await adapter.writeRecord(recordKey(replacement), replacement); await adapter.writeManifest(manifest('target', 4, [replacement]))
    assert.equal(adapter.readRecord(recordKey(old)), undefined)
    await adapter.writeManifest(manifest('old-hash-publication', 1, [old]))
    assert.equal(records.isLoaded(recordKey(old)), true, 'Publication restores a staged old hash released by an earlier publication')
    assert.equal(adapter.readRecord(recordKey(old))?.kind, 'suggestion')
    await repository.close()
  } finally { await f.cleanup() }
})

test('repository commit serialization restores a released old hash after the preceding revision publishes', async () => {
  const f = await fixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), events: string[] = []
  const first = suggestion(f.profileId, 'First'), second = suggestion(f.profileId, 'Second')
  let hold = false
  const openUnit = f.backend.kv.open
  f.backend.kv.open = async descriptor => {
    const unit = await openUnit(descriptor)
    if (descriptor.name.endsWith('_delta_v1')) {
      const put = unit.putRecord.bind(unit), selected = unit.loadSelected?.bind(unit)
      assert.ok(selected)
      unit.putRecord = async (table, key, value) => {
        if (hold && table === 'records' && key === recordKey(second)) { started.resolve(); await release.promise }
        const result = await put(table, key, value)
        if (hold) events.push(`${table}:${key}`)
        return result
      }
      unit.loadSelected = async selection => { if (hold && Array.isArray(selection.records) && selection.records.includes(recordKey(first))) events.push('hydrate-first'); return selected(selection) }
    }
    return unit
  }
  try {
    const opened = await f.open()
    await opened.repository.commit({ aggregateId: 'history', expectedRevision: 0, operationId: 'first', request: {}, records: [first], state: {} })
    const oldPath = join(f.root, `${f.source.name}_delta_v1`, 'records', `${recordKey(first)}.json`), before = await readFile(oldPath, 'utf8'), beforeStat = await stat(oldPath)
    hold = true
    const a = opened.repository.commit({ aggregateId: 'history', expectedRevision: 1, operationId: 'second', request: {}, records: [second], state: {} })
    await started.promise
    const b = opened.repository.commit({ aggregateId: 'history', expectedRevision: 2, operationId: 'return-to-first', request: {}, records: [first], state: {} })
    release.resolve(); await Promise.all([a, b])
    const published = events.findIndex(event => event.startsWith('manifests:')), hydrated = events.indexOf('hydrate-first')
    assert.ok(published >= 0 && hydrated > published)
    assert.equal(opened.repository.get('suggestion', first.id)?.text, 'First')
    assert.equal(await readFile(oldPath, 'utf8'), before); assert.equal((await stat(oldPath)).mtimeMs, beforeStat.mtimeMs)
    assert.equal(events.filter(event => event === `records:${recordKey(first)}`).length, 0)
    await opened.close()
  } finally { release.resolve(); await f.cleanup() }
})

test('selective incremental hydration supports an explicit SQLite route and retains the frozen JSON base', async () => {
  const f = await fixture('sqlite')
  try {
    const legacy = await f.legacy(), original = await f.domain(legacy).createStyle({ operationId: 'legacy', name: 'Frozen base' }, f.actor); await legacy.close()
    const before = await readFile(f.path, 'utf8')
    let opened = await f.open()
    const created = await f.domain(opened.repository).createStyle({ operationId: 'sqlite-style', name: 'SQLite style' }, f.actor)
    await opened.close(); opened = await f.open()
    assert.equal(opened.repository.get('style', original.id)?.name, 'Frozen base')
    assert.equal(opened.repository.get('style', created.id)?.name, 'SQLite style')
    assert.equal((await f.domain(opened.repository).createStyle({ operationId: 'sqlite-style', name: 'SQLite style' }, f.actor)).id, created.id)
    assert.equal(await readFile(f.path, 'utf8'), before); await opened.close()
  } finally { await f.cleanup() }
})

test('the explicit legacy bootstrap requirement preserves its whole-file predecessor before selective reopen', async () => {
  const f = await fixture()
  try {
    let opened = await f.open()
    const saved = suggestion(f.profileId, 'Legacy incremental record')
    await opened.repository.commit({ aggregateId: 'legacy-history', expectedRevision: 0, operationId: 'legacy-suggestion', request: {}, records: [saved], state: {} }); await opened.close()
    const name = `${f.source.name}_delta_v1`, unit = await f.backend.kv.open({ name, version: 1, tables: ['records', 'manifests'], hasGlobal: true, layout: 'per-record' }), snapshot = await unit.loadAll()
    await unit.close()
    const predecessor = join(f.root, `${name}.json`), text = `${JSON.stringify({ unit: { name, version: 1 }, global: snapshot.global, tables: snapshot.tables })}\n`
    await writeFile(predecessor, text, 'utf8')
    const directory = join(f.root, name)
    assert.equal(dirname(directory), f.root)
    await rm(directory, { recursive: true, force: true })
    opened = await f.open()
    assert.equal(opened.repository.get('suggestion', saved.id)?.text, saved.text)
    assert.equal(await readFile(predecessor, 'utf8'), text)
    assert.equal((await readdir(join(directory, 'records'))).filter(file => file.endsWith('.json')).length, 1)
    await opened.close()
  } finally { await f.cleanup() }
})

test('selective loading failures other than the explicit bootstrap requirement never retry through eager loading', async () => {
  const f = await fixture(), failure = Object.assign(new Error('Controlled selective failure'), { code: 'invalid-record' })
  const openUnit = f.backend.kv.open
  let incrementalOpens = 0
  f.backend.kv.open = async descriptor => {
    const unit = await openUnit(descriptor)
    if (descriptor.name.endsWith('_delta_v1')) { incrementalOpens++; unit.loadSelected = async () => { throw failure } }
    return unit
  }
  try {
    await assert.rejects(f.open(), failure)
    assert.equal(incrementalOpens, 1)
  } finally { await f.cleanup() }
})
