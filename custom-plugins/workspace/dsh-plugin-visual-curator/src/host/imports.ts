/** Convert verified private files to immutable, independently owned image associations. */
import { randomUUID } from 'node:crypto'
import { assetSchema, imageVersionSchema, type Asset, type ImageVersion, type DomainActor, type CuratorRecord } from '../shared/model.ts'
import type { ImportedFiles } from '../media/index.ts'
import { CuratorError } from '../shared/errors.ts'

/** Decode bounded upload data without a backtracking expression proportional to camera-file size.
 * @param value Plain padded Base64, without a data URL prefix. @param maxBytes Maximum decoded upload bytes.
 * @returns Validated bytes; invalid alphabet, padding or size fails before media processing.
 */
export function decodeUpload(value: string, maxBytes: number): Buffer {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  if (!value.length || value.length % 4 !== 0 || value.length / 4 * 3 - padding > maxBytes) throw new CuratorError('invalid-input', 'import', 'The encoded image exceeds the configured limit or is malformed.')
  // 大文件的重复分组正则会耗尽 V8 调用栈；逐字符校验保持线性耗时与固定栈深度。
  for (let index = 0; index < value.length - padding; index++) {
    const char = value.charCodeAt(index)
    if (!(char >= 65 && char <= 90 || char >= 97 && char <= 122 || char >= 48 && char <= 57 || char === 43 || char === 47)) throw new CuratorError('invalid-input', 'import', 'The encoded image contains invalid Base64 characters or padding.')
  }
  return Buffer.from(value, 'base64')
}

/** @param profileId Profile identity. @param actor Host authority. @param files Verified immutable file set. @param source Source without transient URLs. @param permission Explicit Client import permission. @returns Records ready for one manifest commit. */
export function importedRecords(profileId: string, actor: DomainActor, files: ImportedFiles, source: Asset['source'], permission: 'references-only' | 'bytes-allowed' = 'references-only'): { asset: Asset; image: ImageVersion; preview: ImageVersion; records: CuratorRecord[] } {
  const now = new Date().toISOString(), base = { schemaVersion: 1, profileId, createdAt: now }
  const asset = assetSchema.parse({ ...base, kind: 'asset', id: randomUUID(), familyId: files.normalized.blob.digest, source, access: actor.sessionId ? { kind: 'session-run', sessionId: actor.sessionId } : { kind: 'profile-library' }, originalBlob: files.originalBlob, exportPermission: permission, ...(permission === 'bytes-allowed' && actor.kind === 'human' ? { exportConfirmedBy: { kind: 'authenticated-human', id: actor.id, confirmationMethod: 'import-confirmation', confirmedAt: now } } : {}), groupingStatus: 'unreviewed' })
  const image = imageVersionSchema.parse({ ...base, kind: 'imageVersion', id: randomUUID(), assetId: asset.id, versionKind: 'normalized', blob: files.normalized.blob, geometry: { width: files.normalized.width, height: files.normalized.height, colorSpace: files.normalized.colorSpace, sourceOrientation: files.normalized.sourceOrientation, processorVersion: files.normalized.processorVersion } })
  const preview = imageVersionSchema.parse({ ...base, kind: 'imageVersion', id: randomUUID(), assetId: asset.id, parentImageVersionId: image.id, versionKind: 'preview', blob: files.preview.blob, geometry: { width: files.preview.width, height: files.preview.height, colorSpace: files.preview.colorSpace, processorVersion: files.preview.processorVersion } })
  return { asset, image, preview, records: [asset, image, preview] }
}
