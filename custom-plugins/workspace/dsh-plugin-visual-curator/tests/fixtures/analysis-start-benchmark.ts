/** Synthetic analysis-start measurements exclude fixture setup and model/network latency. Bundle this module, then run the emitted JavaScript under plain Node. */
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { z } from 'zod'
import { serviceFixture } from '../helpers/service-fixture.ts'
import { UnsplashApi } from '../../src/media/unsplash.ts'
import { resolveConfig } from '../../src/host/config.ts'

const account = { id: 'benchmark-account', label: 'Synthetic', credentialRef: 'BENCHMARK_ONLY', userId: 'benchmark-user', username: 'synthetic', name: 'Synthetic' }
const unsplash = resolveConfig({ source: { unsplash: { accounts: [account] } } }).source.unsplash
const api = new UnsplashApi({ request: async path => path === '/me' ? { id: account.userId, username: account.username, name: account.name, total_collections: 1 } : {
  id: path.split('/').at(-1), width: 400, height: 240,
  urls: { small: `https://images.unsplash.com/synthetic-${path.split('/').at(-1)}?w=400`, regular: `https://images.unsplash.com/synthetic-${path.split('/').at(-1)}?w=1080` },
} })
const results = []
for (const count of [20, 218]) {
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api }, { provider: 'unsplash', unsplash })
  f.http.request = async (_url, input) => {
    input.signal?.throwIfAborted()
    await new Promise<never>((_resolve, reject) => input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true }))
    throw new Error('The synthetic provider must finish through cancellation')
  }
  try {
    await f.service.initialize()
    const styleId = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'benchmark-style', name: 'Synthetic analysis' })).id
    for (let offset = 0; offset < count; offset += 25) await f.action('gallery-import', {
      operationId: `seed-${offset}`, transferId: `seed-transfer-${offset}`, mode: 'remote-reference', accountId: account.id, styleId,
      expectedRevision: f.domain.require('style', styleId).revision, role: 'positive',
      photoIds: Array.from({ length: Math.min(25, count - offset) }, (_, index) => `photo-${offset + index}`),
    })
    const samples = []
    for (let index = 0; index < 3; index++) {
      const scheduled = performance.now(), heartbeat = setImmediate().then(() => performance.now() - scheduled)
      const beforeCpu = process.cpuUsage(), before = performance.now()
      const runId = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: `start-${index}`, styleId, buildDataset: true })).runId
      const elapsedMs = performance.now() - before, cpu = process.cpuUsage(beforeCpu)
      const loopDelayMs = await heartbeat
      samples.push({ elapsedMs: +elapsedMs.toFixed(2), cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(2), loopDelayMs: +loopDelayMs.toFixed(2) })
      await f.action('analysis-stop', { runId })
      await f.jobs.drain()
      if (f.domain.require('run', runId).status !== 'cancelled') throw new Error('Synthetic cancellation did not settle')
    }
    results.push({ references: count, samples })
  } finally { await f.cleanup() }
}
console.log(JSON.stringify({ measured: 'analysis-start-through-production-service', fixtureSetupIncluded: false, modelNetworkIncluded: false, results }, null, 2))
const large = results.find(result => result.references === 218)!
const median = large.samples.map(sample => sample.elapsedMs).sort((a, b) => a - b)[1]!
if (median > 1000) { console.error('Analysis-start local budget exceeded: median must be below 1000ms for 218 references'); process.exitCode = 1 }
