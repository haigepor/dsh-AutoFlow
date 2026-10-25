/** Collection pages validate an ordered prefix so appends do not invalidate an existing cursor. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import type { DomainActor, Json } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { toJson } from './runtime.ts'

/** @param domain Authorized profile records. @param args Collection and bounded page cursor. @param actor Trusted workbench owner. @param defaultSize Deployment page size. @returns Reference-only page and authoritative collection counts. */
export function referencePage(domain: CuratorDomain, args: Record<string, Json>, actor: DomainActor, defaultSize: number): Json {
  const input = z.object({ styleId: z.string(), pageSize: z.number().int().min(1).max(100).default(defaultSize), pageToken: z.string().max(4096).optional() }).parse(args)
  const style = domain.require('style', input.styleId), draft = domain.require('draft', style.draftId), ids = draft.referenceIds
  let offset = 0
  if (input.pageToken) {
    try {
      const token = z.strictObject({ v: z.literal(1), styleId: z.literal(style.id), offset: z.number().int().nonnegative(), prefixDigest: z.string() }).parse(JSON.parse(Buffer.from(input.pageToken, 'base64url').toString('utf8')))
      if (token.offset > ids.length || token.prefixDigest !== contentDigest(ids.slice(0, token.offset))) throw new Error('changed-prefix')
      offset = token.offset
    } catch (error) { throw new CuratorError('invalid-input', 'reference-pagination', 'The collection changed before this page; refresh the list.', { cause: error }) }
  }
  const references = ids.map(id => domain.require('reference', id))
  const counts = { all: ids.length, positive: 0, negative: 0, undecided: 0 }
  for (const reference of references) counts[reference.role]++
  const images = references.slice(offset, offset + input.pageSize).map(reference => {
    const { asset, image } = domain.authorizedImage(reference.imageVersionId, actor)
    return { imageVersionId: image.id, assetId: asset.id, familyId: asset.familyId, width: image.geometry.width, height: image.geometry.height, kind: image.versionKind,
      previewPath: `/api/visual-curator/resource?imageVersionId=${encodeURIComponent(image.id)}`, name: asset.source.description || asset.id, source: asset.source.kind,
      ...(actor.kind === 'human' && image.blob.localSource ? { localPath: image.blob.localSource.path } : {}), exportPermission: asset.exportPermission, groupingStatus: asset.groupingStatus,
      referenceId: reference.id, styleId: style.id, role: reference.role, intent: reference.intent.kind, dimensions: reference.intent.kind === 'dimensions' ? reference.intent.dimensions : [] }
  })
  const next = offset + images.length
  const endPageToken = Buffer.from(JSON.stringify({ v: 1, styleId: style.id, offset: next, prefixDigest: contentDigest(ids.slice(0, next)) })).toString('base64url')
  return toJson({ styleId: style.id, revision: style.revision, draftRevision: draft.revision, referenceIds: ids, total: ids.length, counts, images, endPageToken,
    ...(next < ids.length ? { nextPageToken: Buffer.from(JSON.stringify({ v: 1, styleId: style.id, offset: next, prefixDigest: contentDigest(ids.slice(0, next)) })).toString('base64url') } : {}) })
}
