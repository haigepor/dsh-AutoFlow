/** Versioned canvas documents and typed data dependencies; legacy task records remain unchanged. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { dimensionSchema, routeSchema, referenceSchema, taskIdSchema, ruleIdSchema, failureSchema, StylePromptError } from './model.ts'

export type CanvasId = Branded<'StylePrompt.CanvasId'>
export type NodeId = Branded<'StylePrompt.NodeId'>
export type AssetId = Branded<'StylePrompt.AssetId'>
export type RunId = Branded<'StylePrompt.RunId'>
const id = z.string().min(1).max(100).regex(/^[\w.:-]+$/)
export const canvasId = id.transform(value => brandString<CanvasId>(value))
export const nodeId = id.transform(value => brandString<NodeId>(value))
export const assetId = id.transform(value => brandString<AssetId>(value))
export const runId = id.transform(value => brandString<RunId>(value))
const bilingualDraft = z.strictObject({ zh: z.string().max(1600), en: z.string().max(1600) })
const position = z.strictObject({ x: z.number().finite(), y: z.number().finite() })
const common = { id: nodeId, title: z.string().max(100), position, width: z.number().min(260).max(1000).optional(), height: z.number().min(160).max(1600).optional() }
export const canvasNodeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('reference'), assetIds: z.array(assetId).max(8) }),
  z.strictObject({ ...common, kind: z.literal('analysis'), route: routeSchema.nullable(), dimensions: z.array(dimensionSchema).max(9), historyTaskId: taskIdSchema.nullable() }),
  z.strictObject({ ...common, kind: z.literal('rules'), selectedRuleIds: z.array(ruleIdSchema).max(20).nullable() }),
  z.strictObject({ ...common, kind: z.literal('brief'), brief: bilingualDraft, changes: bilingualDraft }),
  z.strictObject({ ...common, kind: z.literal('prompt'), route: routeSchema.nullable(), mode: z.enum(['quick', 'model']), platform: z.enum(['generic', 'flux2']), historyTaskId: taskIdSchema.nullable() }),
  z.strictObject({ ...common, kind: z.literal('image'), route: routeSchema.nullable(), prompt: z.string().max(8000), variant: z.number().int().min(-1).max(2), size: z.enum(['auto', '1024x1024', '1536x1024', '1024x1536']), quality: z.enum(['auto', 'low', 'medium', 'high']) }),
  z.strictObject({ ...common, kind: z.literal('output'), language: z.enum(['zh', 'en']) }),
])
export type CanvasNode = z.infer<typeof canvasNodeSchema>
export type NodeKind = CanvasNode['kind']
export const edgeSchema = z.strictObject({ id, source: nodeId, sourceHandle: z.string().max(50), target: nodeId, targetHandle: z.string().max(50) })
export type CanvasEdge = z.infer<typeof edgeSchema>
export const canvasSchema = z.strictObject({ formatVersion: z.literal(1), id: canvasId, name: z.string().trim().min(1).max(100), revision: z.number().int().nonnegative(), updatedAt: z.string(), nodes: z.array(canvasNodeSchema).max(500), edges: z.array(edgeSchema).max(1500), viewport: z.strictObject({ ...position.shape, zoom: z.number().min(0.1).max(4) }) })
export type CanvasDocument = z.infer<typeof canvasSchema>
export const assetSchema = z.strictObject({ formatVersion: z.literal(1), id: assetId, createdAt: z.string(), reference: referenceSchema })
export type CanvasAsset = z.infer<typeof assetSchema>
export const canvasExportSchema = z.strictObject({ formatVersion: z.literal(1), exportType: z.literal('style-prompt-canvas'), document: canvasSchema, assets: z.array(z.strictObject({ id: assetId, name: z.string().max(200), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).max(4000) })
const fileRef = z.strictObject({ attachmentId: z.string(), name: z.string(), bytes: z.number().int().nonnegative() })
export const nodeExecutionSchema = z.strictObject({
  nodeId, fingerprint: z.string(), inputKey: z.string(), status: z.enum(['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'interrupted']),
  taskId: taskIdSchema.nullable(), analysisId: taskIdSchema.nullable(), selectedRuleIds: z.array(ruleIdSchema),
  images: z.array(referenceSchema).max(8), originals: z.array(fileRef).max(8), failure: failureSchema.nullable(),
  imageRequest: z.strictObject({ route: routeSchema, prompt: z.string(), size: z.string(), quality: z.string(), references: z.array(referenceSchema) }).nullable(),
  reused: z.boolean().optional(),
})
export type NodeExecution = z.infer<typeof nodeExecutionSchema>
export const canvasRunSchema = z.strictObject({ formatVersion: z.literal(1), id: runId, canvasId, createdAt: z.string(), updatedAt: z.string(), status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']), document: canvasSchema, targets: z.array(nodeId).min(1), nodes: z.array(nodeExecutionSchema), failure: failureSchema.nullable() })
export type CanvasRun = z.infer<typeof canvasRunSchema>
/** Profile inventory reports references and a grace period before explicit cleanup. */
export const canvasAssetInventorySchema = z.strictObject({ total: z.number().int().nonnegative(), limit: z.number().int().positive(), graceMs: z.number().int().positive(), assets: z.array(z.strictObject({ asset: assetSchema, used: z.boolean(), recent: z.boolean() })) })
export type CanvasAssetInventory = z.infer<typeof canvasAssetInventorySchema>

type PortType = 'images' | 'analysis' | 'style' | 'brief' | 'prompt'
/** Ports have semantic types; image inputs accept multiple links, other inputs accept one. */
export const ports: Record<NodeKind, { inputs: Record<string, PortType>; outputs: Record<string, PortType> }> = {
  reference: { inputs: {}, outputs: { images: 'images' } }, analysis: { inputs: { images: 'images' }, outputs: { analysis: 'analysis' } },
  rules: { inputs: { analysis: 'analysis' }, outputs: { style: 'style' } }, brief: { inputs: {}, outputs: { brief: 'brief' } },
  prompt: { inputs: { style: 'style', brief: 'brief' }, outputs: { prompt: 'prompt' } },
  image: { inputs: { prompt: 'prompt', images: 'images' }, outputs: { images: 'images' } },
  output: { inputs: { prompt: 'prompt', images: 'images' }, outputs: {} },
}

/** @param document Draft graph. @param edge Proposed link. @returns Whether the typed, single-input and acyclic connection is allowed. */
export function canConnect(document: Pick<CanvasDocument, 'nodes' | 'edges'>, edge: Omit<CanvasEdge, 'id'>): boolean {
  const source = document.nodes.find(node => node.id === edge.source), target = document.nodes.find(node => node.id === edge.target)
  if (!source || !target || source.id === target.id) return false
  const type = ports[source.kind].outputs[edge.sourceHandle]
  if (!type || type !== ports[target.kind].inputs[edge.targetHandle]) return false
  if (document.edges.some(link => link.target === edge.target && link.targetHandle === edge.targetHandle && (type !== 'images' || link.source === edge.source && link.sourceHandle === edge.sourceHandle))) return false
  const visit = [edge.target], seen = new Set<NodeId>()
  while (visit.length) {
    const next = visit.pop()!
    if (next === edge.source) return false
    if (seen.has(next)) continue
    seen.add(next); visit.push(...document.edges.filter(link => link.source === next).map(link => link.target))
  }
  return true
}

/** @param document Saved or imported graph. @returns The graph after validating unique identities and every connection. */
export function validateCanvas(document: CanvasDocument): CanvasDocument {
  if (new Set(document.nodes.map(node => node.id)).size !== document.nodes.length || new Set(document.edges.map(edge => edge.id)).size !== document.edges.length) throw new StylePromptError('invalid-input')
  const edges: CanvasEdge[] = []
  for (const edge of document.edges) {
    if (!canConnect({ nodes: document.nodes, edges }, edge)) throw new StylePromptError('invalid-input')
    edges.push(edge)
  }
  return document
}

/** @param document Validated acyclic graph. @param targets Explicit target nodes. @returns Required ancestors in dependency order. */
export function executionOrder(document: CanvasDocument, targets: readonly NodeId[]): CanvasNode[] {
  validateCanvas(document)
  const ordered: CanvasNode[] = [], seen = new Set<NodeId>()
  const visit = (id: NodeId): void => {
    if (seen.has(id)) return
    const node = document.nodes.find(value => value.id === id)
    if (!node) throw new StylePromptError('invalid-input')
    seen.add(id)
    for (const edge of document.edges.filter(edge => edge.target === id)) visit(edge.source)
    ordered.push(node)
  }
  targets.forEach(visit)
  return ordered
}

/** Layout never invalidates model results. Ancestor changes, connection changes and parameters do.
 * @param document Acyclic graph. @param id Node to compare with its saved execution.
 * @returns Stable semantic input description.
 */
export function nodeFingerprint(document: CanvasDocument, id: NodeId): string {
  return JSON.stringify(executionOrder(document, [id]).map(node => {
    const { position: _position, title: _title, width: _width, height: _height, ...parameters } = node
    return { parameters, inputs: document.edges.filter(edge => edge.target === node.id).map(({ id: _id, ...edge }) => edge).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }
  }))
}

/** @param kind Business node type. @param id Stable canvas-local identity. @param at Initial position. @returns Editable node with explicit defaults. */
export function newNode(kind: NodeKind, id: NodeId, at = { x: 0, y: 0 }): CanvasNode {
  const common = { id, title: '', position: at }
  switch (kind) {
    case 'reference': return { ...common, kind, assetIds: [] }
    case 'analysis': return { ...common, kind, route: null, dimensions: [...dimensionSchema.options], historyTaskId: null }
    case 'rules': return { ...common, kind, selectedRuleIds: null }
    case 'brief': return { ...common, kind, brief: { zh: '', en: '' }, changes: { zh: '', en: '' } }
    case 'prompt': return { ...common, kind, route: null, mode: 'model', platform: 'generic', historyTaskId: null }
    case 'image': return { ...common, kind, route: null, prompt: '', variant: -1, size: '1024x1024', quality: 'auto' }
    case 'output': return { ...common, kind, language: 'en' }
  }
}

/** @param id New document identity. @returns Connected starter graph with stable local node identities. */
export function starterCanvas(id: CanvasId): CanvasDocument {
  const kinds: NodeKind[] = ['reference', 'analysis', 'rules', 'brief', 'prompt', 'image', 'output']
  const positions = [{ x: 0, y: 60 }, { x: 340, y: 60 }, { x: 680, y: 60 }, { x: 680, y: 420 }, { x: 1020, y: 60 }, { x: 1360, y: 60 }, { x: 1700, y: 60 }]
  const nodes = kinds.map((kind, index) => newNode(kind, nodeId.parse(`node-${index + 1}`), positions[index]))
  const links = [[0, 'images', 1, 'images'], [1, 'analysis', 2, 'analysis'], [2, 'style', 4, 'style'], [3, 'brief', 4, 'brief'], [4, 'prompt', 5, 'prompt'], [5, 'images', 6, 'images']] as const
  return { formatVersion: 1, id, name: 'Untitled', revision: 0, updatedAt: new Date().toISOString(), nodes, edges: links.map(([source, sourceHandle, target, targetHandle], index) => ({ id: `edge-${index}`, source: nodes[source]!.id, sourceHandle, target: nodes[target]!.id, targetHandle })), viewport: { x: 60, y: 60, zoom: 0.65 } }
}

export const canvasActionSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('canvas/list') }),
  z.strictObject({ operation: z.literal('canvas/get'), id: canvasId }),
  z.strictObject({ operation: z.literal('canvas/save'), document: canvasSchema, expectedRevision: z.number().int().nonnegative() }),
  z.strictObject({ operation: z.literal('canvas/delete'), id: canvasId }),
  z.strictObject({ operation: z.literal('canvas/import-history'), id: taskIdSchema, canvasId }),
  z.strictObject({ operation: z.literal('canvas/import'), bundle: canvasExportSchema, canvasId }),
  z.strictObject({ operation: z.literal('canvas/upload'), assets: z.array(z.strictObject({ id: assetId, name: z.string().min(1).max(200), mediaType: referenceSchema.shape.attachment.shape.mediaType, base64: z.string() })).min(1).max(8) }),
  z.strictObject({ operation: z.literal('canvas/run'), id: runId, document: canvasSchema, targets: z.array(nodeId).min(1).max(500) }),
  z.strictObject({ operation: z.literal('canvas/run-get'), id: runId }),
  z.strictObject({ operation: z.literal('canvas/run-delete'), id: runId }),
  z.strictObject({ operation: z.literal('canvas/cancel'), id: runId }),
  z.strictObject({ operation: z.literal('canvas/models') }),
  z.strictObject({ operation: z.literal('canvas/assets') }),
  z.strictObject({ operation: z.literal('canvas/assets-prune'), ids: z.array(assetId).min(1).max(10000), keep: z.array(assetId).max(4000) }),
])
export type CanvasAction = z.infer<typeof canvasActionSchema>
