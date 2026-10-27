/** Synthetic URL registration excludes setup, disk and network latency; bundle before running under plain Node. */
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { serviceFixture } from '../helpers/service-fixture.ts'
import { UnsplashApi } from '../../src/media/unsplash.ts'

const results = []
for (const historyMiB of [0, 24]) {
  const samples = []
  for (let sample = 0; sample < 3; sample++) {
    let requests = 0
    const api = new UnsplashApi({ request: async path => {
      requests++
      return { id: path.split('/').at(-1), width: 400, height: 240, urls: { small: 'https://images.unsplash.com/synthetic?w=400' } }
    } })
    const f = await serviceFixture(undefined, {}, { galleryApi: async () => api, galleryMedia: { request: async () => { throw new Error('Registration cannot fetch pixels') } } })
    try {
      await f.service.initialize()
      // Tail history represents retained request/process payloads; no private corpus enters this fixture.
      for (let index = 0; index < historyMiB / 2; index++) await f.repository.commit({ aggregateId: `synthetic-history:${index}`, expectedRevision: 0, operationId: `synthetic-history:${index}`, request: {}, records: [], state: { payload: 'synthetic'.repeat(2 * 1024 * 1024 / 9) } })
      const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'synthetic-style', name: 'Synthetic' }))
      const start = performance.now(), cpuStart = process.cpuUsage()
      await f.action('gallery-reference-start', { operationId: 'synthetic-import', styleId, photoIds: ['one', 'two', 'three', 'four'] })
      await f.jobs.drain()
      const elapsedMs = performance.now() - start, cpu = process.cpuUsage(cpuStart)
      const count = f.domain.require('draft', f.domain.require('style', styleId).draftId).referenceIds.length
      if (count !== 4 || requests !== 4) throw new Error('The measured endpoint must publish four references without duplicate metadata requests')
      samples.push({ elapsedMs: +elapsedMs.toFixed(2), cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(2), references: count, metadataRequests: requests })
    } finally { await f.cleanup() }
  }
  results.push({ historyMiB, samples })
}
console.log(JSON.stringify({ operation: 'four-URL-references-through-production-service', fixtureSetupIncluded: false, diskIncluded: false, modelNetworkIncluded: false, results }, null, 2))
