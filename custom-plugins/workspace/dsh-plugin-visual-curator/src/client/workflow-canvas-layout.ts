/** Device-local node geometry contains no image URLs, task inputs or credentials. */
import { z } from 'zod'
import { planningImageLane, imageWorkflowPresentationStages } from './workflow-image-branches.ts'

const point = z.strictObject({ x: z.number().finite(), y: z.number().finite() })
const kinds = z.enum(['references', 'dataset', 'results', 'downloading', 'planning', 'rendering', 'reviewing'])
const viewport = point.extend({ zoom: z.number().min(0.15).max(2) })
const size = z.strictObject({ width: z.number().finite().min(260).max(1200), height: z.number().finite().min(160).max(1200).optional() })
const v5Schema = z.strictObject({ version: z.literal(5), positions: z.record(z.string(), point), sizes: z.record(z.string(), size), viewport })
const v6Schema = v5Schema.extend({ version: z.literal(6), owners: z.record(z.string(), z.string()) })
const layoutSchema = v6Schema.extend({ version: z.literal(7), manual: z.array(z.string()), collapsed: z.record(z.string(), z.boolean()).optional() })
const v4Schema = v5Schema.extend({ version: z.literal(4) })
const previousSchema = z.strictObject({ version: z.literal(3), positions: z.record(z.string(), point), viewport })
const legacySchema = z.strictObject({ version: z.union([z.literal(1), z.literal(2)]), positions: z.partialRecord(kinds, point), viewport })
/** Seven business stages are projected separately for each source batch. */
export type WorkflowNodeKind = z.infer<typeof kinds>
/** Geometry saved independently from immutable task and dataset records. */
export type WorkflowCanvasLayout = z.infer<typeof layoutSchema>
/** Columns leave room for the wider result node and curved connections. */
export const workflowPositions: Record<WorkflowNodeKind, { x: number; y: number }> = { references: { x: 0, y: 0 }, dataset: { x: 440, y: 48 }, results: { x: 880, y: 0 }, downloading: { x: 1540, y: 48 }, planning: { x: 2020, y: 0 }, rendering: { x: 2500, y: 48 }, reviewing: { x: 2980, y: 0 } }

function insertDownloadColumn(positions: WorkflowCanvasLayout['positions']): WorkflowCanvasLayout['positions'] {
  return Object.fromEntries(Object.entries(positions).map(([id, at]) => [id, /:(planning|rendering|reviewing)$/.test(id) ? { ...at, x: at.x + 480 } : at]))
}

type Dimensions = { width: number; height: number }
/** Place sequential cards on one readable row; disjoint horizontal ranges leave room for return connections.
 * @param nodes Ordered cards with their measured or configured widths.
 * @returns Automatic positions with room for forward and return connections.
 */
export function workflowStaggeredPositions(nodes: readonly { id: string; width: number }[]): Record<string, { x: number; y: number }> {
  let left = 0
  return Object.fromEntries(nodes.map(node => {
    const position = { x: left, y: 0 }; left += node.width + 140
    return [node.id, position]
  }))
}
/** @param nodes Current image-node rectangles. @param sourceId Rework source. @param targetId Rework destination. @param gap Required label width and port clearance. @returns Horizontal positions that open space without changing other lanes or relative spacing. */
export function workflowConnectionSpacing(nodes: readonly { id: string; position: { x: number; y: number }; width: number; height: number }[], sourceId: string, targetId: string, gap: number): Record<string, { x: number; y: number }> {
  const source = nodes.find(node => node.id === sourceId), target = nodes.find(node => node.id === targetId)
  if (!source || !target) return {}
  const verticalGap = Math.max(source.position.y - target.position.y - target.height, target.position.y - source.position.y - source.height)
  if (verticalGap >= 64) return {}
  const [left, right] = source.position.x + source.width / 2 <= target.position.x + target.width / 2 ? [source, target] : [target, source]
  const offset = Math.ceil(gap - (right.position.x - left.position.x - left.width))
  if (offset <= 0) return {}
  return Object.fromEntries(nodes.filter(node => node.id !== left.id && node.position.x >= right.position.x).map(node => [node.id, { x: node.position.x + offset, y: node.position.y }]))
}

function nodeIdentity(id: string) {
  const fixed = id.lastIndexOf(':image-step:')
  if (fixed > 0) {
    const stage = id.slice(fixed + ':image-step:'.length, id.lastIndexOf(':')), order = imageWorkflowPresentationStages.findIndex(step => step.stage === stage)
    const step = imageWorkflowPresentationStages[order]
    if (step && step.kind === id.slice(id.lastIndexOf(':') + 1)) return { lane: id.slice(0, fixed), kind: step.kind === 'decision' ? 'planning' as const : step.kind, image: true, order }
  }
  const imageLane = planningImageLane(id)
  if (imageLane) return { lane: imageLane, kind: 'planning' as const, image: true, order: kinds.options.indexOf('planning') }
  const split = id.lastIndexOf(':'), kind = kinds.safeParse(id.slice(split + 1))
  return split > 0 && kind.success ? { lane: id.slice(0, split), kind: kind.data, order: kinds.options.indexOf(kind.data) } : undefined
}
function nodeDimensions(id: string, kind: WorkflowNodeKind, sizes: WorkflowCanvasLayout['sizes'], measured: ReadonlyMap<string, Dimensions>): Dimensions {
  const saved = sizes[id], actual = measured.get(id)
  return { width: Math.max(saved?.width ?? (kind === 'results' ? 560 : ['downloading', 'planning', 'rendering', 'reviewing'].includes(kind) ? 380 : 340), actual?.width ?? 0), height: actual?.height ?? saved?.height ?? (kind === 'results' || nodeIdentity(id)?.image ? 420 : 260) }
}
function separateImageNodes(positions: WorkflowCanvasLayout['positions'], sizes: WorkflowCanvasLayout['sizes'], measured: ReadonlyMap<string, Dimensions>, manual: readonly string[], visible: readonly string[]): WorkflowCanvasLayout['positions'] {
  type Rectangle = Dimensions & { id: string; x: number; y: number; order: number }
  const lanes = new Map<string, Rectangle[]>()
  for (const [order, id] of visible.entries()) {
    const identity = nodeIdentity(id), at = positions[id]
    if (!id.includes(':image-step:') || !identity || !at) continue
    const size = measured.get(id) ?? nodeDimensions(id, identity.kind, sizes, measured)
    const rectangle = { id, ...at, ...size, order }, lane = lanes.get(identity.lane)
    if (lane) lane.push(rectangle); else lanes.set(identity.lane, [rectangle])
  }
  let result = positions
  for (const rectangles of lanes.values()) {
    const placed = rectangles.filter(rectangle => manual.includes(rectangle.id))
    let previous: Rectangle | undefined
    for (const rectangle of rectangles.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
      if (manual.includes(rectangle.id)) continue
      const next = { ...rectangle, x: Math.max(rectangle.x, previous ? previous.x + previous.width + 140 : rectangle.x) }
      for (;;) {
        const conflicts = placed.filter(other => next.x < other.x + other.width + 140 && next.x + next.width + 140 > other.x && next.y < other.y + other.height + 64 && next.y + next.height + 64 > other.y)
        if (!conflicts.length) break
        next.x = Math.max(...conflicts.map(other => other.x + other.width + 140))
      }
      if (next.x !== rectangle.x) {
        if (result === positions) result = { ...positions }
        result[rectangle.id] = { x: next.x, y: next.y }
      }
      placed.push(next); previous = next
    }
  }
  return result
}
function separateLanes(positions: WorkflowCanvasLayout['positions'], sizes: WorkflowCanvasLayout['sizes'], measured: ReadonlyMap<string, Dimensions>, manual: readonly string[]): WorkflowCanvasLayout['positions'] {
  const groups = new Map<string, { ids: string[]; left: number; top: number; right: number; bottom: number }>()
  for (const [id, at] of Object.entries(positions)) {
    const identity = nodeIdentity(id)
    if (!identity || identity.lane === 'current') continue
    const dimensions = nodeDimensions(id, identity.kind, sizes, measured), group = groups.get(identity.lane)
    if (group) { group.ids.push(id); group.left = Math.min(group.left, at.x); group.top = Math.min(group.top, at.y); group.right = Math.max(group.right, at.x + dimensions.width); group.bottom = Math.max(group.bottom, at.y + dimensions.height) }
    else groups.set(identity.lane, { ids: [id], left: at.x, top: at.y, right: at.x + dimensions.width, bottom: at.y + dimensions.height })
  }
  const pinned = new Set(manual.flatMap(id => { const identity = nodeIdentity(id); return identity ? [identity.lane] : [] }))
  const placed: { left: number; top: number; right: number; bottom: number }[] = [...groups].filter(([id]) => pinned.has(id)).map(([, group]) => group)
  let result = positions
  for (const [lane, group] of [...groups].sort(([a, left], [b, right]) => left.top - right.top || a.localeCompare(b))) {
    if (pinned.has(lane)) continue
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

function resizeWithinLane(layout: WorkflowCanvasLayout, measured: ReadonlyMap<string, Dimensions>, orderById: ReadonlyMap<string, number>, id: string, requested: Dimensions & { x?: number; y?: number }) {
  const identity = nodeIdentity(id), at = layout.positions[id]
  if (!identity || !at) return { positions: layout.positions, size: requested }
  type Rectangle = Dimensions & { x: number; y: number }
  const overlaps = (left: Rectangle, right: Rectangle) => left.x < right.x + right.width + 100 && left.x + left.width + 100 > right.x && left.y < right.y + right.height + 100 && left.y + left.height + 100 > right.y
  const rectangles = new Map(Object.entries(layout.positions).flatMap(([key, point]) => {
    const node = nodeIdentity(key)
    return node ? [[key, { ...point, ...nodeDimensions(key, node.kind, layout.sizes, measured) }] as const] : []
  }))
  const siblings = [...rectangles].filter(([key]) => key !== id && nodeIdentity(key)?.lane === identity.lane)
  const fixed = siblings.filter(([key]) => layout.manual.includes(key)).map(([, rectangle]) => rectangle)
  const otherLanes = new Map<string, Rectangle>()
  for (const [key, rectangle] of rectangles) {
    const lane = nodeIdentity(key)!.lane
    if (lane === identity.lane || lane === 'current') continue
    const prior = otherLanes.get(lane), x = Math.min(prior?.x ?? rectangle.x, rectangle.x), y = Math.min(prior?.y ?? rectangle.y, rectangle.y)
    otherLanes.set(lane, { x, y, width: Math.max(prior ? prior.x + prior.width : rectangle.x + rectangle.width, rectangle.x + rectangle.width) - x, height: Math.max(prior ? prior.y + prior.height : rectangle.y + rectangle.height, rectangle.y + rectangle.height) - y })
  }
  const order = orderById.get(id) ?? identity.order
  const automatic = siblings.filter(([key]) => !layout.manual.includes(key)).sort(([a], [b]) => {
    const first = (orderById.get(a) ?? nodeIdentity(a)!.order) - order, second = (orderById.get(b) ?? nodeIdentity(b)!.order) - order
    return Math.abs(first) - Math.abs(second)
  })
  const fit = (size: Dimensions) => {
    const x = requested.x !== undefined && requested.x !== at.x ? requested.x + requested.width - size.width : at.x
    const y = requested.y !== undefined && requested.y !== at.y ? requested.y + requested.height - size.height : at.y
    const changed = new Map<string, Rectangle>([[id, { x, y, width: size.width, height: size.height }]])
    if (fixed.some(rectangle => overlaps(changed.get(id)!, rectangle))) return undefined
    for (const [key, rectangle] of automatic) {
      const conflicts = [...changed.values()].filter(other => overlaps(rectangle, other))
      if (!conflicts.length) continue
      const after = (orderById.get(key) ?? nodeIdentity(key)!.order) > order
      const x = after ? Math.max(rectangle.x, ...conflicts.map(other => other.x + other.width + 100)) : Math.min(rectangle.x, ...conflicts.map(other => other.x - rectangle.width - 100))
      const moved = { ...rectangle, x }, swept = { ...rectangle, x: Math.min(x, rectangle.x), width: rectangle.width + Math.abs(x - rectangle.x) }
      if (fixed.some(other => overlaps(swept, other))) return undefined
      changed.set(key, moved)
    }
    const own = [[id, rectangles.get(id)!] as const, ...siblings].map(([key, rectangle]) => ({ key, rectangle: changed.get(key) ?? rectangle }))
    for (const [key, rectangle] of changed) if (own.some(other => other.key !== key && overlaps(rectangle, other.rectangle))) return undefined
    const left = Math.min(...own.map(node => node.rectangle.x)), top = Math.min(...own.map(node => node.rectangle.y))
    const bounds = { x: left, y: top, width: Math.max(...own.map(node => node.rectangle.x + node.rectangle.width)) - left, height: Math.max(...own.map(node => node.rectangle.y + node.rectangle.height)) - top }
    if ([...otherLanes.values()].some(other => overlaps(bounds, other))) return undefined
    return { positions: { ...layout.positions, ...Object.fromEntries([...changed].map(([key, rectangle]) => [key, { x: rectangle.x, y: rectangle.y }])) }, size }
  }
  const exact = fit(requested)
  if (exact) return exact
  const previous = rectangles.get(id)!, base = { width: Math.min(previous.width, requested.width), height: Math.min(previous.height, requested.height) }
  let accepted = fit(base)
  if (!accepted) return { positions: layout.positions, size: { width: previous.width, height: previous.height } }
  for (const axis of ['width', 'height'] as const) {
    let low = accepted.size[axis], high = requested[axis]
    while (high - low > 1) {
      const middle = Math.floor((high + low) / 2), candidate = fit({ ...accepted.size, [axis]: middle })
      if (candidate) { low = middle; accepted = candidate } else high = middle
    }
    const candidate = fit({ ...accepted.size, [axis]: high })
    if (candidate) accepted = candidate
  }
  return accepted
}

/** @param React Shared application runtime. @returns Batch-keyed local geometry and explicit arrangement. */
export function createWorkflowCanvasLayout(React: typeof import('react')) {
  return function useWorkflowCanvasLayout(styleId: string) {
    const key = `visual-curator:workflow-canvas:v7:${styleId}`
    const [initial] = React.useState<{ layout: WorkflowCanvasLayout | undefined; legacy: z.infer<typeof legacySchema> | undefined; available: boolean }>(() => {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw) { const parsed = layoutSchema.safeParse(JSON.parse(raw)); return { layout: parsed.success ? parsed.data : undefined, legacy: undefined, available: parsed.success } }
        const v6 = window.localStorage.getItem(`visual-curator:workflow-canvas:v6:${styleId}`)
        if (v6) { const parsed = v6Schema.safeParse(JSON.parse(v6)); return { layout: parsed.success ? { ...parsed.data, version: 7 as const, manual: Object.keys(parsed.data.positions) } : undefined, legacy: undefined, available: parsed.success } }
        const v5 = window.localStorage.getItem(`visual-curator:workflow-canvas:v5:${styleId}`)
        if (v5) { const parsed = v5Schema.safeParse(JSON.parse(v5)); return { layout: parsed.success ? { ...parsed.data, version: 7 as const, owners: {}, manual: Object.keys(parsed.data.positions) } : undefined, legacy: undefined, available: parsed.success } }
        const v4 = window.localStorage.getItem(`visual-curator:workflow-canvas:v4:${styleId}`)
        if (v4) { const parsed = v4Schema.safeParse(JSON.parse(v4)); return { layout: parsed.success ? { ...parsed.data, version: 7 as const, owners: {}, manual: Object.keys(parsed.data.positions), positions: insertDownloadColumn(parsed.data.positions) } : undefined, legacy: undefined, available: parsed.success } }
        const v3 = window.localStorage.getItem(`visual-curator:workflow-canvas:v3:${styleId}`)
        if (v3) { const parsed = previousSchema.safeParse(JSON.parse(v3)); return { layout: parsed.success ? { ...parsed.data, version: 7 as const, owners: {}, manual: Object.keys(parsed.data.positions), positions: insertDownloadColumn(parsed.data.positions), sizes: {} } : undefined, legacy: undefined, available: parsed.success } }
        const previous = window.localStorage.getItem(`visual-curator:workflow-canvas:v2:${styleId}`) ?? window.localStorage.getItem(`visual-curator:workflow-canvas:v1:${styleId}`)
        const parsed = previous ? legacySchema.safeParse(JSON.parse(previous)) : undefined
        return { layout: undefined, legacy: parsed?.success ? parsed.data : undefined, available: !previous || parsed?.success === true }
      } catch (error) { return { layout: undefined, legacy: undefined, available: false } }
    })
    const [positions, setPositions] = React.useState<WorkflowCanvasLayout['positions']>(() => separateLanes(initial.layout?.positions ?? {}, initial.layout?.sizes ?? {}, new Map(), initial.layout?.manual ?? []))
    const [sizes, setSizes] = React.useState<WorkflowCanvasLayout['sizes']>(initial.layout?.sizes ?? {})
    const [collapsed, setCollapsedState] = React.useState(initial.layout?.collapsed ?? {})
    const [available, setAvailable] = React.useState(initial.available)
    const measured = React.useRef(new Map<string, Dimensions>())
    const automaticSlots = React.useRef(new Map<string, number>())
    const visibleOrder = React.useRef(new Map<string, number>())
    // XYResizer reports raw node changes after onResize has constrained the rectangle.
    const resizing = React.useRef(new Map<string, { requested: Dimensions & { x: number; y: number }; size: Dimensions }>())
    const [geometryRevision, setGeometryRevision] = React.useState(0)
    const firstLane = React.useRef<string | undefined>(undefined)
    const current = React.useRef<WorkflowCanvasLayout>({ version: 7, positions, sizes, collapsed, manual: initial.layout?.manual ?? [], owners: initial.layout?.owners ?? {}, viewport: initial.layout?.viewport ?? initial.legacy?.viewport ?? { x: 0, y: 0, zoom: 1 } })
    const move = (id: string, at: { x: number; y: number }) => {
      const resize = resizing.current.get(id)
      if (resize?.requested.x === at.x && resize.requested.y === at.y) return
      resizing.current.delete(id)
      const prior = current.current.positions[id]
      if (prior?.x === at.x && prior.y === at.y) return
      current.current = { ...current.current, manual: current.current.manual.includes(id) ? current.current.manual : [...current.current.manual, id], positions: { ...current.current.positions, [id]: { x: at.x, y: at.y } } }
      setPositions(current.current.positions)
    }
    const save = (at = current.current.viewport) => {
      current.current = { ...current.current, viewport: { x: at.x, y: at.y, zoom: at.zoom } }
      try { window.localStorage.setItem(key, JSON.stringify(current.current)); setAvailable(true) }
      catch (error) { setAvailable(false) }
    }
    return { sizes, collapsed, available, geometryRevision, initialViewport: initial.layout?.viewport ?? initial.legacy?.viewport, move, save,
      setCollapsed(update: import('react').SetStateAction<Record<string, boolean>>) {
        const next = typeof update === 'function' ? update(current.current.collapsed ?? {}) : update
        current.current = { ...current.current, collapsed: next }; setCollapsedState(next); save()
      },
      place(positions: Record<string, { x: number; y: number }>, resetManual = false) {
        current.current = { ...current.current, positions: { ...current.current.positions, ...positions }, ...(resetManual ? { manual: current.current.manual.filter(id => !(id in positions)) } : {}) }
        setPositions(current.current.positions)
        if (resetManual) save()
      },
      measuredDimensions(id: string) { return measured.current.get(id) },
      lane(launchId: string | undefined, runId: string, knownRuns: readonly string[]) {
        if (!launchId) return runId
        if (!current.current.owners[launchId]) current.current = { ...current.current, owners: { ...current.current.owners, [launchId]: knownRuns[0] ?? runId } }
        return current.current.owners[launchId] === runId ? launchId : runId
      },
      forget(ids: readonly string[]) {
        const removed = new Set(ids), keep = (id: string) => !removed.has(nodeIdentity(id)?.lane ?? id)
        const positions = Object.fromEntries(Object.entries(current.current.positions).filter(([id]) => keep(id)))
        const sizes = Object.fromEntries(Object.entries(current.current.sizes).filter(([id]) => keep(id)))
        const collapsed = Object.fromEntries(Object.entries(current.current.collapsed ?? {}).filter(([id]) => keep(id)))
        const owners = Object.fromEntries(Object.entries(current.current.owners).filter(([id, runId]) => !removed.has(id) && !removed.has(runId)))
        for (const id of measured.current.keys()) if (!keep(id)) measured.current.delete(id)
        for (const id of automaticSlots.current.keys()) if (!keep(id)) automaticSlots.current.delete(id)
        for (const id of resizing.current.keys()) if (!keep(id)) resizing.current.delete(id)
        current.current = { ...current.current, positions, sizes, collapsed, owners, manual: current.current.manual.filter(keep) }; setPositions(positions); setSizes(sizes); setCollapsedState(collapsed); setGeometryRevision(value => value + 1); save()
      },
      measure(id: string, value: Dimensions) {
        const resize = resizing.current.get(id)
        if (resize) { resizing.current.delete(id); if (value.width === resize.requested.width && value.height === resize.requested.height) value = resize.size }
        const prior = measured.current.get(id)
        if (prior?.width === value.width && prior.height === value.height) return
        measured.current.set(id, value); setGeometryRevision(revision => revision + 1)
      },
      reconcile(at = current.current.viewport, visibleImageIds?: readonly string[], automaticPositions?: Readonly<Record<string, { x: number; y: number }>>) {
        if (visibleImageIds) visibleOrder.current = new Map(visibleImageIds.map((id, index) => [id, index]))
        const positions = automaticPositions ? { ...current.current.positions } : current.current.positions
        if (automaticPositions) for (const [id, position] of Object.entries(automaticPositions)) {
          if (positions[id] && !current.current.manual.includes(id)) positions[id] = position
        }
        const own = visibleImageIds ? separateImageNodes(positions, current.current.sizes, measured.current, current.current.manual, visibleImageIds) : positions
        const next = separateLanes(own, current.current.sizes, measured.current, current.current.manual)
        current.current = { ...current.current, positions: next }; setPositions(next); save(at)
      },
      resize(id: string, value: Dimensions & { x?: number; y?: number }, collapsed = false) {
        const previous = current.current.sizes[id]
        const fitted = resizeWithinLane(current.current, measured.current, visibleOrder.current, id, value)
        const next = { width: fitted.size.width, ...(collapsed ? previous?.height ? { height: previous.height } : {} : { height: fitted.size.height }) }
        const at = current.current.positions[id], positioned = fitted.positions[id]
        if (at) resizing.current.set(id, { requested: { ...value, x: value.x ?? at.x, y: value.y ?? at.y }, size: fitted.size })
        const manual = at && positioned && (at.x !== positioned.x || at.y !== positioned.y) && !current.current.manual.includes(id) ? [...current.current.manual, id] : current.current.manual
        measured.current.set(id, fitted.size)
        current.current = { ...current.current, manual, positions: fitted.positions, sizes: { ...current.current.sizes, [id]: next } }; setPositions(fitted.positions); setSizes(current.current.sizes)
      },
      resetSize(id: string) {
        const { [id]: ignored, ...rest } = current.current.sizes
        current.current = { ...current.current, sizes: rest }; setSizes(rest); save()
      },
      position(id: string, kind: WorkflowNodeKind, laneId: string, automaticAt?: { x: number; y: number }, slot?: number) {
        firstLane.current ??= laneId
        if (firstLane.current === 'current' && laneId !== 'current') {
          const hasBatch = Object.keys(current.current.positions).some(key => { const identity = nodeIdentity(key); return identity && identity.lane !== 'current' })
          if (!hasBatch) {
            for (const stage of kinds.options) {
              const prior = current.current.positions[`current:${stage}`]
              if (prior) current.current = { ...current.current, manual: current.current.manual.includes(`current:${stage}`) ? [...current.current.manual, `${laneId}:${stage}`] : current.current.manual, positions: { ...current.current.positions, [`${laneId}:${stage}`]: prior } }
            }
          }
          firstLane.current = laneId
        }
        const saved = current.current.positions[id]
        const changedSlot = slot !== undefined && automaticSlots.current.get(id) !== slot
        if (slot !== undefined) automaticSlots.current.set(id, slot)
        if (saved && (!changedSlot || current.current.manual.includes(id))) return saved
        // A step can move between the two visible slots; its prior automatic column is not a manual placement.
        if (changedSlot && automaticAt) {
          current.current = { ...current.current, positions: { ...current.current.positions, [id]: automaticAt } }
          return automaticAt
        }
        const own = Object.entries(current.current.positions).filter(([key]) => nodeIdentity(key)?.lane === laneId)
        if (id.endsWith(':image-step:clarity:rendering') && current.current.positions[id.replace(':clarity:rendering', ':reviewing:reviewing')]) {
          // New history-only steps occupy a free row; saved manual positions and the viewport stay intact.
          const bottom = Math.max(0, ...own.map(([key, at]) => at.y + nodeDimensions(key, nodeIdentity(key)!.kind, current.current.sizes, measured.current).height))
          automaticAt = { x: automaticAt?.x ?? workflowPositions.rendering.x, y: bottom + 100 }
        }
        const occupied = Object.entries(current.current.positions).flatMap(([key, at]) => { const identity = nodeIdentity(key); return identity && identity.lane !== 'current' ? [at.y + nodeDimensions(key, identity.kind, current.current.sizes, measured.current).height + 100] : [] })
        const top = own.length ? Math.min(...own.map(([, at]) => at.y)) : laneId === 'current' ? 0 : Math.max(0, ...occupied)
        const at = automaticAt ?? (laneId === firstLane.current ? initial.legacy?.positions[kind] : undefined) ?? { x: workflowPositions[kind].x, y: top + workflowPositions[kind].y }
        current.current = { ...current.current, manual: laneId === firstLane.current && initial.legacy?.positions[kind] ? [...current.current.manual, id] : current.current.manual, positions: { ...current.current.positions, [id]: at } }
        return at
      },
      arrange(nodes: { id: string; kind: WorkflowNodeKind; row: number; imageSlot?: number }[]) {
        const columns = kinds.options.filter(kind => nodes.some(node => node.kind === kind)), widths = new Map<WorkflowNodeKind, number>(), heights = new Map<number, number>()
        const branchHeights = new Map<number, number>(), headerHeights = new Map<number, number>()
        for (const node of nodes) {
          resizing.current.delete(node.id)
          const dimensions = nodeDimensions(node.id, node.kind, current.current.sizes, measured.current)
          widths.set(node.kind, Math.max(widths.get(node.kind) ?? 0, dimensions.width))
          heights.set(node.row, Math.max(heights.get(node.row) ?? 0, dimensions.height))
          if (node.imageSlot !== undefined) branchHeights.set(node.row, Math.max(branchHeights.get(node.row) ?? 420, dimensions.height))
          else if (node.kind === 'planning') headerHeights.set(node.row, Math.max(300, dimensions.height))
        }
        const branchOffset = (node: { row: number; imageSlot?: number }) => node.imageSlot === undefined ? 0 : (headerHeights.get(node.row) ?? 300) + 80 + node.imageSlot * ((branchHeights.get(node.row) ?? 420) + 60)
        for (const node of nodes) if (node.imageSlot !== undefined) heights.set(node.row, Math.max(heights.get(node.row) ?? 0, branchOffset(node) + nodeDimensions(node.id, node.kind, current.current.sizes, measured.current).height))
        const x = new Map<WorkflowNodeKind, number>(), y = new Map<number, number>(); let left = 0, top = 0
        for (const kind of columns) { x.set(kind, left); left += (widths.get(kind) ?? 340) + 100 }
        for (const row of [...heights.keys()].sort((a, b) => a - b)) { y.set(row, top); top += heights.get(row)! + 100 }
        const arranged = Object.fromEntries(nodes.map(node => [node.id, { x: x.get(node.kind)!, y: y.get(node.row)! + branchOffset(node) + columns.indexOf(node.kind) % 2 * 48 }]))
        const manual = current.current.manual.filter(id => !Object.hasOwn(arranged, id))
        current.current = { ...current.current, manual, positions: separateLanes({ ...current.current.positions, ...arranged }, current.current.sizes, measured.current, manual) }; setPositions(current.current.positions); save()
      },
    }
  }
}
