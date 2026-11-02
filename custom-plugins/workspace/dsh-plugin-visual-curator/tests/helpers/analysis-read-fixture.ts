/** Stored keyless analysis records with independent observable storage for read-path regressions. */
import { analysisPlanFixture } from './analysis-plan-fixture.ts'
import { CuratorDomain } from '../../src/domain/curator.ts'
import { DomainRepository, MemoryDomainAdapter } from '../../src/domain/repository.ts'
import { RunEngine } from '../../src/host/runtime.ts'
import { recordSchema, type CuratorRecord } from '../../src/shared/model.ts'

/** @param total Synthetic reference count. @param observed Saved observations. @returns Real readers over copied committed records; no worker or external request starts during reads. */
export async function analysisReadFixture(total = 16, observed = 12) {
  const original = await analysisPlanFixture(total, observed), adapter = new MemoryDomainAdapter()
  try {
    const records = new Map<string, CuratorRecord>()
    for (const schema of recordSchema.options) for (const record of original.repository.list(schema.shape.kind.value)) records.set(`${record.kind}:${record.id}`, record)
    for (const manifest of original.repository.manifests()) {
      adapter.commits.set(manifest.aggregateId, structuredClone(manifest))
      for (const pointer of manifest.records) {
        const record = records.get(`${pointer.kind}:${pointer.id}`)
        if (!record) throw new Error('The analysis read fixture has an unsupported or missing committed record')
        adapter.records.set(pointer.key, structuredClone(record))
      }
    }
    const repository = new DomainRepository(original.profileId, adapter), domain = new CuratorDomain(original.profileId, repository), engine = new RunEngine(repository, original.jobs)
    return { ...original, adapter, repository, domain, engine,
      async commit(records: readonly CuratorRecord[], operationId: string) {
        const manifest = repository.manifest(original.aggregateId)!
        await repository.commit({ aggregateId: manifest.aggregateId, expectedRevision: manifest.revision, operationId, request: {}, records, state: manifest.state })
      },
      cleanup: async () => { try { await engine.dispose() } finally { await original.cleanup() } },
    }
  } catch (error) { await original.cleanup(); throw error }
}
