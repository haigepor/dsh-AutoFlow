/** Compare production storage layouts under plain Node; setup and network latency are excluded. */
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { storageFixture } from '../helpers/storage-fixture.ts'
import { suggestionSchema } from '../../src/shared/model.ts'
import { RemoteGalleryReferences } from '../../src/host/gallery-references.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { UnsplashApi } from '../../src/media/unsplash.ts'

const results = []
for (const layout of ['single', 'incremental'] as const) {
  const samples = []
  for (let sample = 0; sample < 3; sample++) {
    const f = await storageFixture()
    try {
      const seed = await f.legacy()
      const records = Array.from({ length: 4 }, (_, index) => suggestionSchema.parse({ schemaVersion: 1, profileId: f.profileId, kind: 'suggestion', id: `synthetic-${index}`, createdAt: '2026-10-27T00:00:00.000Z', author: { kind: 'agent', sourceId: 'synthetic' }, status: 'pending', text: 'x'.repeat(6 * 1024 * 1024), feedbackIds: [] }))
      await seed.commit({ aggregateId: 'synthetic-history', expectedRevision: 0, operationId: 'synthetic-history', request: {}, records, state: {} }); await seed.close()
      const before = await readFile(f.path, 'utf8')
      const opened = layout === 'single' ? { repository: await f.legacy(), close: async () => {} } : await f.open()
      const domain = f.domain(opened.repository)
      const start = performance.now()
      const style = await domain.createStyle({ operationId: 'benchmark-style', name: 'Synthetic' }, f.actor)
      const createMs = performance.now() - start
      let requests = 0
      const api = new UnsplashApi({ request: async path => { requests++; return { id: path.split('/').at(-1), width: 400, height: 240, urls: { small: 'https://images.unsplash.com/synthetic?w=400' } } } })
      const remote = new RemoteGalleryReferences(resolveConfig({}), domain, () => {})
      const importStart = performance.now()
      await remote.import({ operationId: 'benchmark-import', transferId: 'benchmark-transfer', styleId: style.id, expectedRevision: style.revision, photoIds: ['one', 'two', 'three', 'four'] }, api, f.actor, { maxBytes: 1_000_000, timeoutMs: 1000, maxRedirects: 0 }, async () => {})
      const importMs = performance.now() - importStart
      if (domain.require('draft', domain.require('style', style.id).draftId).referenceIds.length !== 4 || requests !== 4) throw new Error('The measured endpoint must publish every reference with one metadata lookup each')
      const baseUnchanged = before === await readFile(f.path, 'utf8')
      if (layout === 'incremental' && !baseUnchanged) throw new Error('Incremental writes changed the frozen base')
      samples.push({ createMs: +createMs.toFixed(2), importMs: +importMs.toFixed(2), baseBytes: Buffer.byteLength(before), baseUnchanged, references: 4, metadataRequests: requests })
      if (layout === 'single') await opened.repository.close()
      else await opened.close()
    } finally { await f.cleanup() }
  }
  results.push({ layout, samples })
}
console.log(JSON.stringify({ operation: 'create-and-publish-four-URL-references', syntheticHistoryMiB: 24, setupIncluded: false, diskIncluded: true, networkIncluded: false, results }, null, 2))
