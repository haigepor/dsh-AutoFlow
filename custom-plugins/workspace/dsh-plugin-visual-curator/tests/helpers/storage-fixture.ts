/** Isolated production JSON/domain composition; no user profile or network is used. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SqliteStorageBackend } from '../../../../../packages/storage/storage-sqlite/src/index.ts'
import { CuratorDomain } from '../../src/domain/curator.ts'
import { DomainRepository, StorageDomainAdapter, curatorDomainSpecFor, openCuratorRepository } from '../../src/domain/repository.ts'

/** @param incrementalBackend Explicit alternate route for the incremental unit. @returns Real storage services, private temporary paths and a disposer that releases every writer. */
export async function storageFixture(incrementalBackend: 'json' | 'sqlite' = 'json') {
  const root = await mkdtemp(join(tmpdir(), 'curator-incremental-'))
  const ctx = new Context(), fiber = ctx.plugin(Storage)
  await fiber.inertia
  const backend = new JsonStorageBackend(root)
  const unregister = ctx.effect(() => ctx.storage.backend.register('json', backend))
  const profileId = 'incremental-fixture', actor = { kind: 'human' as const, id: 'owner', profileId }
  const source = curatorDomainSpecFor(profileId), path = join(root, `${source.name}.json`)
  const sqlite = incrementalBackend === 'sqlite' ? new SqliteStorageBackend({ path: join(root, 'curator.sqlite'), journalMode: 'wal' }) : undefined
  const unregisterSqlite = sqlite ? ctx.effect(() => ctx.storage.backend.register('sqlite', sqlite)) : undefined
  const facility = new DomainFacility(ctx, { backend: 'json', ...(sqlite ? { routes: { [`${source.name}_delta_v1`]: 'sqlite' } } : {}) })
  const legacy = async () => new DomainRepository(profileId, new StorageDomainAdapter(await facility.open(source)))
  const closers = new Set<() => Promise<void>>()
  const open = async () => {
    const opened = await openCuratorRepository({ profileId, facility, lockPath: join(root, 'writer.lock') })
    const close = async () => { try { await opened.close() } finally { closers.delete(close) } }
    closers.add(close)
    return { repository: opened.repository, close }
  }
  const domain = (repository: DomainRepository) => new CuratorDomain(profileId, repository)
  const cleanup = async () => {
    try { await Promise.all([...closers].map(close => close())) }
    finally { await facility.closeAll(); await unregisterSqlite?.(); await unregister(); await sqlite?.close(); await backend.close(); await fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  }
  return { root, backend, sqlite, facility, profileId, actor, source, path, legacy, open, domain, cleanup }
}
