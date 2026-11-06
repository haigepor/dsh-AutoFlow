/** Device-local node geometry contains no image URLs, task inputs or credentials. */
import { z } from 'zod'

const point = z.strictObject({ x: z.number().finite(), y: z.number().finite() })
const kinds = z.enum(['references', 'dataset', 'results', 'downloading', 'planning', 'rendering', 'reviewing'])
const viewport = point.extend({ zoom: z.number().min(0.15).max(2) })
const size = z.strictObject({ width: z.number().finite().min(260).max(1200), height: z.number().finite().min(160).max(1200).optional() })
const v5Schema = z.strictObject({ version: z.literal(5), positions: z.record(z.string(), point), sizes: z.record(z.string(), size), viewport })
const layoutSchema = v5Schema.extend({ version: z.literal(6), owners: z.record(z.string(), z.string()) })
const v4Schema = v5Schema.extend({ version: z.literal(4) })
const previousSchema = z.strictObject({ version: z.literal(3), positions: z.record(z.string(), point), viewport })
const legacySchema = z.strictObject({ version: z.union([z.literal(1), z.literal(2)]), positions: z.partialRecord(kinds, point), viewport })
/** Seven business stages are projected separately for each source batch. */
export type WorkflowNodeKind = z.infer<typeof kinds>
/** Geometry saved independently from immutable task and dataset records. */
export type WorkflowCanvasLayout = z.infer<typeof layoutSchema>
/** Columns leave room for the wider result node and curved connections. */
export const workflowPositions: Record<WorkflowNodeKind, { x: number; y: number }> = { references: { x: 0, y: 0 }, dataset: { x: 440, y: 0 }, results: { x: 880, y: 0 }, downloading: { x: 1540, y: 0 }, planning: { x: 2020, y: 0 }, rendering: { x: 2500, y: 0 }, reviewing: { x: 2980, y: 0 } }

function insertDownloadColumn(positions: WorkflowCanvasLayout['positions']): WorkflowCanvasLayout['positions'] {
  return Object.fromEntries(Object.entries(positions).map(([id, at]) => [id, /:(planning|rendering|reviewing)$/.test(id) ? { ...at, x: at.x + 480 } : at]))
}

type Dimensions = { width: number; height: number }
function nodeIdentity(id: string) {
  const split = id.lastIndexOf(':'), kind = kinds.safeParse(id.slice(split + 1))
  return split > 0 && kind.success ? { lane: id.slice(0, split), kind: kind.data } : undefined
}
function nodeDimensions(id: string, kind: WorkflowNodeKind, sizes: WorkflowCanvasLayout['sizes'], measured: ReadonlyMap<string, Dimensions>): Dimensions {
  const saved = sizes[id], actual = measured.get(id)
  return { width: Math.max(saved?.width ?? (kind === 'results' ? 560 : ['downloading', 'planning', 'rendering', 'reviewing'].includes(kind) ? 380 : 340), actual?.width ?? 0), height: Math.max(saved?.height ?? 620, actual?.height ?? 0) }
}
function separateLanes(positions: WorkflowCanvasLayout['positions'], sizes: WorkflowCanvasLayout['sizes'], measured: ReadonlyMap<string, Dimensions>): WorkflowCanvasLayout['positions'] {
  const groups = new Map<string, { ids: string[]; left: number; top: number; right: number; bottom: number }>()
  for (const [id, at] of Object.entries(positions)) {
    const identity = nodeIdentity(id)
    if (!identity || identity.lane === 'current') continue
    const dimensions = nodeDimensions(id, identity.kind, sizes, measured), group = groups.get(identity.lane)
    if (group) { group.ids.push(id); group.left = Math.min(group.left, at.x); group.top = Math.min(group.top, at.y); group.right = Math.max(group.right, at.x + dimensions.width); group.bottom = Math.max(group.bottom, at.y + dimensions.height) }
    else groups.set(identity.lane, { ids: [id], left: at.x, top: at.y, right: at.x + dimensions.width, bottom: at.y + dimensions.height })
  }
  const placed: { left: number; top: number; right: number; bottom: number }[] = []
  let result = positions
  for (const [, group] of [...groups].sort(([a, left], [b, right]) => left.top - right.top || a.localeCompare(b))) {
    let offset = 0
    for (;;) {
      const conflicts = placed.filter(other => group.left < other.right + 100 && group.right + 100 > other.left && group.top + offset < other.bottom + 100 && group.bottom + offset + 100 > other.top)
      if (!conflicts.length) break
      offset = Math.max(...conflicts.map(other => other.bottom + 100)) - group.top
    }
    if (offset) {
      if (result === positions) result = { ...positions }
      for (const id of group.ids) result[id] = { ...positions[id]!, y: positions[id]!.y + offset }
    }
    placed.push({ left: group.left, top: group.top + offset, right: group.right, bottom: group.bottom + offset })
  }
  return result
}

/** @param React Shared application runtime. @returns Batch-keyed local geometry and explicit arrangement. */
export function createWorkflowCanvasLayout(React: typeof import('react')) {
  return function useWorkflowCanvasLayout(styleId: string) {
    const key = `visual-curator:workflow-canvas:v6:${styleId}`
    const [initial] = React.useState(() => {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw) { const parsed = layoutSchema.safeParse(JSON.parse(raw)); return { layout: parsed.success ? parsed.data : undefined, legacy: undefined, available: parsed.success } }
        const v5 = window.localStorage.getItem(`visual-curator:workflow-canvas:v5:${styleId}`)
        if (v5) { const parsed = v5Schema.safeParse(JSON.parse(v5)); return { layout: parsed.success ? { ...parsed.data, version: 6 as const, owners: {} } : undefined, legacy: undefined, available: parsed.success } }
        const v4 = window.localStorage.getItem(`visual-curator:workflow-canvas:v4:${styleId}`)
        if (v4) { const parsed = v4Schema.safeParse(JSON.parse(v4)); return { layout: parsed.success ? { ...parsed.data, version: 6 as const, owners: {}, positions: insertDownloadColumn(parsed.data.positions) } : undefined, legacy: undefined, available: parsed.success } }
        const v3 = window.localStorage.getItem(`visual-curator:workflow-canvas:v3:${styleId}`)
        if (v3) { const parsed = previousSchema.safeParse(JSON.parse(v3)); return { layout: parsed.success ? { ...parsed.data, version: 6 as const, owners: {}, positions: insertDownloadColumn(parsed.data.positions), sizes: {} } : undefined, legacy: undefined, available: parsed.success } }
        const previous = window.localStorage.getItem(`visual-curator:workflow-canvas:v2:${styleId}`) ?? window.localStorage.getItem(`visual-curator:workflow-canvas:v1:${styleId}`)
        const parsed = previous ? legacySchema.safeParse(JSON.parse(previous)) : undefined
        return { layout: undefined, legacy: parsed?.success ? parsed.data : undefined, available: !previous || parsed?.success === true }
      } catch (error) { return { layout: undefined, legacy: undefined, available: false } }
    })
    const [positions, setPositions] = React.useState<WorkflowCanvasLayout['positions']>(() => separateLanes(initial.layout?.positions ?? {}, initial.layout?.sizes ?? {}, new Map()))
    const [sizes, setSizes] = React.useState<WorkflowCanvasLayout['sizes']>(initial.layout?.sizes ?? {})
    const [available, setAvailable] = React.useState(initial.available)
    const measured = React.useRef(new Map<string, Dimensions>())
    const [geometryRevision, setGeometryRevision] = React.useState(0)
    const firstLane = React.useRef<string | undefined>(undefined)
    const current = React.useRef<WorkflowCanvasLayout>({ version: 6, positions, sizes, owners: initial.layout?.owners ?? {}, viewport: initial.layout?.viewport ?? initial.legacy?.viewport ?? { x: 0, y: 0, zoom: 1 } })
    const move = (id: string, at: { x: number; y: number }) => {
      current.current = { ...current.current, positions: { ...current.current.positions, [id]: { x: at.x, y: at.y } } }
      setPositions(current.current.positions)
    }
    const save = (at = current.current.viewport) => {
      current.current = { ...current.current, viewport: { x: at.x, y: at.y, zoom: at.zoom } }
      try { window.localStorage.setItem(key, JSON.stringify(current.current)); setAvailable(true) }
      catch (error) { setAvailable(false) }
    }
    return { sizes, available, geometryRevision, initialViewport: initial.layout?.viewport ?? initial.legacy?.viewport, move, save,
      lane(launchId: string | undefined, runId: string, knownRuns: readonly string[]) {
        if (!launchId) return runId
        if (!current.current.owners[launchId]) current.current = { ...current.current, owners: { ...current.current.owners, [launchId]: knownRuns[0] ?? runId } }
        return current.current.owners[launchId] === runId ? launchId : runId
      },
      forget(ids: readonly string[]) {
        const removed = new Set(ids), keep = (id: string) => !removed.has(nodeIdentity(id)?.lane ?? id)
        const positions = Object.fromEntries(Object.entries(current.current.positions).filter(([id]) => keep(id)))
        const sizes = Object.fromEntries(Object.entries(current.current.sizes).filter(([id]) => keep(id)))
        const owners = Object.fromEntries(Object.entries(current.current.owners).filter(([id, runId]) => !removed.has(id) && !removed.has(runId)))
        for (const id of measured.current.keys()) if (!keep(id)) measured.current.delete(id)
        current.current = { ...current.current, positions, sizes, owners }; setPositions(positions); setSizes(sizes); setGeometryRevision(value => value + 1); save()
      },
      measure(id: string, value: Dimensions) {
        const prior = measured.current.get(id)
        if (prior?.width === value.width && prior.height === value.height) return
        measured.current.set(id, value); setGeometryRevision(revision => revision + 1)
      },
      reconcile(at = current.current.viewport) {
        const next = separateLanes(current.current.positions, current.current.sizes, measured.current)
        current.current = { ...current.current, positions: next }; setPositions(next); save(at)
      },
      resize(id: string, value: { width: number; height: number }, collapsed = false) {
        const previous = current.current.sizes[id]
        const next = { width: value.width, ...(collapsed ? previous?.height ? { height: previous.height } : {} : { height: value.height }) }
        current.current = { ...current.current, sizes: { ...current.current.sizes, [id]: next } }; setSizes(current.current.sizes)
      },
      resetSize(id: string) {
        const { [id]: ignored, ...rest } = current.current.sizes
        current.current = { ...current.current, sizes: rest }; setSizes(rest); save()
      },
      position(id: string, kind: WorkflowNodeKind, laneId: string) {
        firstLane.current ??= laneId
        if (firstLane.current === 'current' && laneId !== 'current') {
          const hasBatch = Object.keys(current.current.positions).some(key => { const identity = nodeIdentity(key); return identity && identity.lane !== 'current' })
          if (!hasBatch) {
            for (const stage of kinds.options) {
              const prior = current.current.positions[`current:${stage}`]
              if (prior) current.current = { ...current.current, positions: { ...current.current.positions, [`${laneId}:${stage}`]: prior } }
            }
          }
          firstLane.current = laneId
        }
        const saved = current.current.positions[id]
        if (saved) return saved
        const own = Object.entries(current.current.positions).filter(([key]) => nodeIdentity(key)?.lane === laneId)
        const occupied = Object.entries(current.current.positions).flatMap(([key, at]) => { const identity = nodeIdentity(key); return identity && identity.lane !== 'current' ? [at.y + nodeDimensions(key, identity.kind, current.current.sizes, measured.current).height + 100] : [] })
        const top = own.length ? Math.min(...own.map(([, at]) => at.y)) : laneId === 'current' ? 0 : Math.max(0, ...occupied)
        const at = (laneId === firstLane.current ? initial.legacy?.positions[kind] : undefined) ?? { x: workflowPositions[kind].x, y: top }
        current.current = { ...current.current, positions: { ...current.current.positions, [id]: at } }
        return at
      },
      arrange(nodes: { id: string; kind: WorkflowNodeKind; row: number }[]) {
        const columns = kinds.options, widths = new Map<WorkflowNodeKind, number>(), heights = new Map<number, number>()
        for (const node of nodes) {
          const dimensions = nodeDimensions(node.id, node.kind, current.current.sizes, measured.current)
          widths.set(node.kind, Math.max(widths.get(node.kind) ?? 0, dimensions.width))
          heights.set(node.row, Math.max(heights.get(node.row) ?? 0, dimensions.height))
        }
        const x = new Map<WorkflowNodeKind, number>(), y = new Map<number, number>(); let left = 0, top = 0
        for (const kind of columns) { x.set(kind, left); left += (widths.get(kind) ?? 340) + 100 }
        for (const row of [...heights.keys()].sort((a, b) => a - b)) { y.set(row, top); top += heights.get(row)! + 100 }
        const arranged = Object.fromEntries(nodes.map(node => [node.id, { x: x.get(node.kind)!, y: y.get(node.row)! }]))
        current.current = { ...current.current, positions: separateLanes({ ...current.current.positions, ...arranged }, current.current.sizes, measured.current) }; setPositions(current.current.positions); save()
      },
    }
  }
}
