/** Bundle and run under plain Node; fixture setup and model/network latency are excluded. */
import { performance } from 'node:perf_hooks'
import { analysisPlanFixture } from '../helpers/analysis-plan-fixture.ts'
import { referenceStateSchema } from '../../src/shared/reference-state.ts'
import { planReferenceAnalysis, validObservationReuse } from '../../src/host/reference-state.ts'
import { recipeSchema } from '../../src/shared/model.ts'
import { specOf } from '../../src/host/runtime.ts'

const results = []
for (const [total, observed] of [[20, 18], [329, 299]]) {
  const f = await analysisPlanFixture(total, observed)
  try {
    const samples = []
    for (let sample = 0; sample < 3; sample++) {
      const before = performance.now(), cpu = process.cpuUsage()
      const plan = referenceStateSchema.parse(await f.action('reference-state', { styleId: f.styleId }))
      const elapsedMs = performance.now() - before, used = process.cpuUsage(cpu)
      if (plan.total !== total || plan.reusable !== observed || plan.pending !== total! - observed!) throw new Error('Synthetic analysis range changed')
      samples.push({ elapsedMs: +elapsedMs.toFixed(2), cpuMs: +((used.user + used.system) / 1000).toFixed(2) })
    }
    const recipe = recipeSchema.parse(specOf(f.historical).fixed.recipe), prepared = f.repository.readSnapshot(() => planReferenceAnalysis(f.domain, f.styleId, f.actor, recipe))
    const input = { draft: prepared.draft, references: prepared.references, feedback: prepared.feedback, recipe, analysisOutput: 'observations-only' }, validationSamples = []
    for (let sample = 0; sample < 3; sample++) {
      const before = performance.now(), cpu = process.cpuUsage()
      const valid = f.repository.readSnapshot(() => validObservationReuse(f.domain, input, prepared.reused, f.actor))
      const elapsedMs = performance.now() - before, used = process.cpuUsage(cpu)
      if (!valid) throw new Error('Committed observations must remain reusable')
      validationSamples.push({ elapsedMs: +elapsedMs.toFixed(2), cpuMs: +((used.user + used.system) / 1000).toFixed(2) })
    }
    results.push({ total, observed, samples, validationSamples })
  } finally { await f.cleanup() }
}
console.log(JSON.stringify({ measured: 'reference-state-through-production-service', fixtureSetupIncluded: false, modelNetworkIncluded: false, results }, null, 2))
