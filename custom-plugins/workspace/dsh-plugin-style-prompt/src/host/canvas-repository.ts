/** Canvas storage is additive: the released task domain and its records are never rewritten. */
import { createHash } from 'node:crypto'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { assetSchema, canvasSchema, canvasRunSchema, type CanvasDocument, type CanvasAsset, type CanvasRun, type CanvasId, type AssetId, type RunId } from '../shared/canvas.ts'

export interface CanvasRepository {
  documents(): CanvasDocument[]
  document(id: CanvasId): CanvasDocument | undefined
  saveDocument(value: CanvasDocument): Promise<void>
  deleteDocument(id: CanvasId): Promise<void>
  asset(id: AssetId): CanvasAsset | undefined
  assets(): CanvasAsset[]
  saveAsset(value: CanvasAsset): Promise<void>
  deleteAsset(id: AssetId): Promise<void>
  runs(): CanvasRun[]
  run(id: RunId): CanvasRun | undefined
  saveRun(value: CanvasRun): Promise<void>
  deleteRun(id: RunId): Promise<void>
  close(): Promise<void>
}

/** The caller holds the existing profile writer lease until this repository closes.
 * @param facility Profile-local durable storage.
 * @param profilePath Identity shared with the legacy task repository.
 * @returns Caller-owned additive canvas domain.
 */
export async function openCanvasRepository(facility: Pick<DomainFacility, 'open'>, profilePath: string): Promise<CanvasRepository> {
  const domain = await facility.open(defineDomain({ name: `style_canvas_${createHash('sha256').update(profilePath).digest('hex').slice(0, 24)}`, version: 1,
    tables: { documents: domainTable<CanvasId, CanvasDocument>(canvasSchema), assets: domainTable<AssetId, CanvasAsset>(assetSchema), runs: domainTable<RunId, CanvasRun>(canvasRunSchema) } }))
  const documents = domain.table('documents'), assets = domain.table('assets'), runs = domain.table('runs')
  return {
    documents: () => [...documents.entries()].map(([, value]) => structuredClone(value)), document: id => structuredClone(documents.get(id)),
    saveDocument: value => documents.put(value.id, structuredClone(value)), deleteDocument: async id => { await documents.delete(id) },
    assets: () => [...assets.entries()].map(([, value]) => structuredClone(value)), asset: id => structuredClone(assets.get(id)), saveAsset: value => assets.put(value.id, structuredClone(value)),
    deleteAsset: async id => { await assets.delete(id) },
    runs: () => [...runs.entries()].map(([, value]) => structuredClone(value)), run: id => structuredClone(runs.get(id)), saveRun: value => runs.put(value.id, structuredClone(value)), deleteRun: async id => { await runs.delete(id) },
    close: () => domain.close(),
  }
}
