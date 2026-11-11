/** Cached choices never spend image quota or mutate old probe receipts. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Storage from '../../../../packages/storage/storage/src/index.ts'
import { DomainFacility, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { MemoryStorageBackend } from '../../../../packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import { openImageCatalog } from '../src/host/image-catalog.ts'
test('reading a legacy auto-probe catalog preserves saved receipts and never starts network or image work', async () => {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(), dispose = ctx.storage.backend.register('fixture', backend)
  const storage = new DomainFacility(ctx, { backend: 'fixture', routes: {} })
  const saved = { models: [{ id: 'gpt-image-saved', name: 'Saved model', url: 'https://developers.openai.com/api/docs/models/gpt-image-saved' }],
    probes: [{ accountKey: 'saved-account', modelId: 'gpt-image-saved', operationId: 'saved-operation', createdAt: 1, state: 'outcome-unknown', taskId: 'saved-task' }], fetchedAt: 1 }
  const spec = defineDomain({ name: 'catalog_fixture', version: 1, tables: { state: domainTable(z.object({ models: z.array(z.object({ id: z.string(), name: z.string(), url: z.string() })), probes: z.array(z.object({ accountKey: z.string(), modelId: z.string(), operationId: z.string(), createdAt: z.number(), state: z.string(), taskId: z.string() })), fetchedAt: z.number() })) } })
  let calls = 0
  const forbidden = async () => { calls++; throw new Error('Automatic external work must be disabled') }
  try {
    const seed = await storage.open(spec); await seed.table('state').put('catalog', saved); await seed.close()
    const catalog = await openImageCatalog({ storage, domainName: spec.name, accounts: { list: forbidden, getAccountStatus: forbidden }, images: { submitProbe: forbidden, getResult: forbidden, list: forbidden }, fetch: forbidden,
      options: () => ({ enabled: true, autoProbe: true, refreshMs: 1, verificationTtlMs: 1, timeoutMs: 1000, maxCatalogBytes: 1024, minimumRemainingPercent: 50 }), pollIntervalMs: () => 1,
      signal: new AbortController().signal, reportError() { throw new Error('No discovery operation exists') } })
    for (let i = 0; i < 3; i++) { assert.equal(catalog.read().autoProbe, false); assert.deepEqual(catalog.models(), saved.models) }
    await catalog.close(); assert.equal(calls, 0)
    const reopened = await storage.open(spec); assert.deepEqual(reopened.table('state').get('catalog'), saved); await reopened.close()
  } finally { dispose(); await backend.close(); await ctx.fiber.dispose() }
})
