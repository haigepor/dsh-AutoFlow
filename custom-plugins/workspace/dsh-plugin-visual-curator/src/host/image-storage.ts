/** Retain private files referenced by every committed record and receipt, including hidden task history. */
import type { DomainRepository } from '../domain/repository.ts'
import { CuratorError } from '../shared/errors.ts'
import { recordSchema } from '../shared/model.ts'
import { z } from 'zod'

const recordKindSchema = z.enum(recordSchema.options.map(schema => schema.shape.kind.value))

/** @param repository Profile-owned committed metadata. @returns All retained digest-file references without exposing record contents. */
export function referencedImageStorageFiles(repository: DomainRepository): Set<string> {
  return repository.readSnapshot(() => {
    const retained = new Set<string>(), visited = new Set<string>()
    const collect = (value: unknown): void => {
      if (typeof value === 'string') { if (/^blobs\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(value)) retained.add(value); return }
      if (Array.isArray(value)) { for (const child of value) collect(child); return }
      if (value !== null && typeof value === 'object') for (const child of Object.values(value)) collect(child)
    }
    const manifests = repository.manifests()
    collect(manifests)
    for (const manifest of manifests) for (const pointer of manifest.records) {
      if (visited.has(pointer.key)) continue
      visited.add(pointer.key)
      const record = repository.get(recordKindSchema.parse(pointer.kind), pointer.id)
      if (!record) throw new CuratorError('reference-unavailable', 'image-storage', 'Committed image storage references are unavailable.')
      collect(record)
    }
    return retained
  })
}
