/** Convert verified private files to immutable, independently owned image associations. */
import { randomUUID } from 'node:crypto'
import { assetSchema, imageVersionSchema, type Asset, type ImageVersion, type DomainActor, type CuratorRecord } from '../shared/model.ts'
import type { ImportedFiles } from '../media/index.ts'

/** @param profileId Profile identity. @param actor Host authority. @param files Verified immutable file set. @param source Source without transient URLs. @param permission Explicit Client import permission. @returns Records ready for one manifest commit. */
export function importedRecords(profileId: string, actor: DomainActor, files: ImportedFiles, source: Asset['source'], permission: 'references-only' | 'bytes-allowed' = 'references-only'): { asset: Asset; image: ImageVersion; preview: ImageVersion; records: CuratorRecord[] } {
  const now = new Date().toISOString(), base = { schemaVersion: 1, profileId, createdAt: now }
  const asset = assetSchema.parse({ ...base, kind: 'asset', id: randomUUID(), familyId: files.normalized.blob.digest, source, access: actor.sessionId ? { kind: 'session-run', sessionId: actor.sessionId } : { kind: 'profile-library' }, originalBlob: files.originalBlob, exportPermission: permission, ...(permission === 'bytes-allowed' && actor.kind === 'human' ? { exportConfirmedBy: { kind: 'authenticated-human', id: actor.id, confirmationMethod: 'import-confirmation', confirmedAt: now } } : {}), groupingStatus: 'unreviewed' })
  const image = imageVersionSchema.parse({ ...base, kind: 'imageVersion', id: randomUUID(), assetId: asset.id, versionKind: 'normalized', blob: files.normalized.blob, geometry: { width: files.normalized.width, height: files.normalized.height, colorSpace: files.normalized.colorSpace, sourceOrientation: files.normalized.sourceOrientation, processorVersion: files.normalized.processorVersion } })
  const preview = imageVersionSchema.parse({ ...base, kind: 'imageVersion', id: randomUUID(), assetId: asset.id, parentImageVersionId: image.id, versionKind: 'preview', blob: files.preview.blob, geometry: { width: files.preview.width, height: files.preview.height, colorSpace: files.preview.colorSpace, processorVersion: files.preview.processorVersion } })
  return { asset, image, preview, records: [asset, image, preview] }
}
