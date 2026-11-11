/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Direct image flows compose the existing cards, edge animation and durable canvas layout. */
import { ReactFlow, Background, MiniMap, Panel, Handle, Position, MarkerType, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import type { ServerTransferView } from '../shared/server-queue.ts'
import type { DirectCropBatch } from '../shared/direct-crop.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { wallpaperImageWorkStatus } from '../shared/wallpaper.ts'
import { createWallpaperCanvas, type WallpaperInvoke } from './wallpaper-canvas.tsx'
import { createWorkflowCanvasLayout, workflowStaggeredPositions } from './workflow-canvas-layout.ts'
import { createWorkflowEdge, type WorkflowEdge } from './workflow-edge.tsx'
import { imageWorkflowPresentationStages, imageWorkflowConnections, imageWorkflowStagePhase, imageWorkflowStageReached, imageWorkflowWindow, imageWorkflowRework, fixedImageWorkflowNodeId, type ImageWorkflowStage } from './workflow-image-branches.ts'
import { workflowPhaseKeys, type WallpaperStep, type WorkflowPhase } from './workflow-node-state.ts'

/** @param React Host runtime. @param ui Existing primitives. @returns A standalone crop canvas sharing saved plan and review controls. */
export function createDirectCropCanvas(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const wallpaper = createWallpaperCanvas(React, ui), useLayout = createWorkflowCanvasLayout(React), Wire = createWorkflowEdge(React)
  type Control = ReturnType<typeof wallpaper.useWallpaper>
  type Data = { upload?: ServerTransferView | { status: 'unavailable' } | undefined; onServer?: (() => void) | undefined; control: Control; t: WorkbenchText; kind: WallpaperStep | 'decision'; stage: ImageWorkflowStage; title: string; index: number; phase: WorkflowPhase; upcoming: boolean; previousReview: boolean; collapsed: boolean; toggle(): void }
  type FlowNode = Node<Data, 'direct'>
  function Step({ data }: NodeProps<FlowNode>) {
    return <section className="vc-flow-node" data-phase={data.phase} data-upcoming={data.upcoming || undefined} data-collapsed={data.collapsed || undefined}>
      <Handle type="target" position={Position.Left} id="in" /><Handle type="source" position={Position.Right} id="out" />
      {data.stage === 'reviewing' && <Handle type="source" position={Position.Top} id="return" />}
      {data.stage === 'rendering' && <Handle type="target" position={Position.Top} id="rework" />}
      <header className="vc-flow-node-titlebar"><ui.StateDot state={data.phase === 'completed' ? 'done' : data.phase === 'running' ? 'ongoing' : data.phase === 'attention' || data.phase === 'failed' ? 'error' : 'idle'} /><div><h3>{data.title}</h3><span>{data.previousReview ? data.t('wallpaperPreviousReview') + ' · ' + data.control.attempt?.revision : data.upcoming ? data.t(data.stage === 'reviewing' ? 'wallpaperReviewPending' : 'wallpaperNextStep') : data.t(workflowPhaseKeys[data.phase])}</span></div><small>{String(data.index + 1).padStart(2, '0')}</small><ui.Button size="sm" variant="ghost" className="nodrag" aria-label={data.t(data.collapsed ? 'directCropExpand' : 'collapse')} aria-expanded={!data.collapsed} onClick={data.toggle}><ui.IconChevronDownOutlineRegular size={14} /></ui.Button></header>
      {!data.collapsed && (data.kind === 'decision' ? <wallpaper.DecisionCard control={data.control} t={data.t} /> : data.upcoming ? <wallpaper.UpcomingStepCard control={data.control} t={data.t} waitingLabel={data.stage === 'final' ? data.t('wallpaperAwaitingApproval') : undefined} /> : <wallpaper.ImageStepCard kind={data.kind} stage={data.stage} control={data.control} t={data.t} />)}
      {!data.upcoming && data.stage === 'final' && data.upload && <div className="vc-flow-node-actions vc-server-stage-status"><ui.Tag tone={data.phase === 'attention' || data.phase === 'failed' ? 'warning' : 'neutral'}>{data.t(data.upload.status === 'uploaded' ? data.upload.current === false ? 'serverOldUpload' : 'serverUploaded' : data.upload.status === 'unavailable' ? 'serverTransferUnavailable' : data.upload.status === 'unknown' ? 'serverUnknown' : data.upload.status === 'failed' ? 'serverUploadFailed' : data.upload.status === 'uploading' ? 'serverUploading' : 'serverUploadWaiting')}</ui.Tag>{data.onServer && <ui.Button size="sm" variant="ghost" onClick={data.onServer}>{data.t('serverUploadDetails')}</ui.Button>}</div>}
    </section>
  }
  const nodeTypes = { direct: Step }, edgeTypes = { workflow: Wire }
  return function DirectCropCanvas({ refreshKey = 0, onServer, batch, invoke, t, pollMs, pageSize, scope, imageVersionId, onImage, onTask }: { refreshKey?: number; onServer?(): void; batch: DirectCropBatch; invoke: WallpaperInvoke; t: WorkbenchText; pollMs: number; pageSize: number; scope: string; imageVersionId?: string | undefined; onImage(id: string): void; onTask(runId: string): void }) {
    const control = wallpaper.useWallpaper(batch, invoke, pollMs, pageSize, refreshKey), layout = useLayout(`${scope}:direct:${batch.runId}:progressive-v2`)
    const flow = React.useRef<ReactFlowInstance<FlowNode, WorkflowEdge> | null>(null), restored = React.useRef(false)
    React.useEffect(() => {
      if (!restored.current && control.itemIndex) {
        restored.current = true
        const index = control.itemIndex.findIndex(item => item.imageVersionId === imageVersionId)
        if (index >= 0) control.page(index)
      }
    }, [control.itemIndex, imageVersionId])
    React.useEffect(() => { if (control.item) onImage(control.item.imageVersionId) }, [control.item?.imageVersionId, onImage])
    React.useEffect(() => { if (control.value) onTask(control.value.runId) }, [control.value?.runId, onTask])
    const [history, setHistory] = React.useState<{ image: string; revision: number | undefined; stage: ImageWorkflowStage | undefined } | undefined>()
    const inspected = history?.image === control.item?.imageVersionId && history?.revision === control.attempt?.revision ? history?.stage : undefined
    const navigationLoading = !control.error && control.loading
    const lane = `direct-${batch.runId}`, steps = imageWorkflowWindow(control.item, control.attempt, inspected)
    const automatic = workflowStaggeredPositions(steps.map(step => { const id = fixedImageWorkflowNodeId(lane, step.stage); return { id, width: layout.measuredDimensions(id)?.width ?? 380 } }))
    const nodes: FlowNode[] = steps.flatMap((step, slot) => {
      const index = slot, nodeControl = control
      const upcoming = step.stage !== 'decision' && !imageWorkflowStageReached(step.stage, control.item, control.attempt)
      const id = fixedImageWorkflowNodeId(lane, step.stage), measured = layout.measuredDimensions(id), observedPhase = control.item && control.value ? imageWorkflowStagePhase(step.stage, control.item, wallpaperImageWorkStatus(control.value, control.item.imageVersionId), nodeControl.attempt) : 'idle'
      const upload = step.stage === 'final' && batch.origin === 'server' ? control.value?.serverTransfers?.[control.item?.imageVersionId ?? ''] ?? { status: 'unavailable' as const } : undefined
      const phase: WorkflowPhase = upload && observedPhase === 'completed' ? upload.status === 'uploaded' ? upload.current === false ? 'attention' : 'completed' : upload.status === 'failed' ? 'failed' : upload.status === 'unknown' || upload.status === 'unavailable' ? 'attention' : upload.status === 'uploading' ? 'running' : 'queued' : observedPhase
      // Controlled replacements retain observed dimensions so status changes cannot hide measured nodes.
      return [{ id, type: 'direct', ...(measured ? { measured } : {}), position: layout.position(id, step.kind === 'decision' ? 'planning' : step.kind, lane, automatic[id], slot), style: { width: 380 }, dragHandle: '.vc-flow-node-titlebar', data: { upload, onServer, control: nodeControl, t, upcoming, previousReview: false, kind: step.kind, stage: step.stage, title: t(step.stage === 'final' && batch.origin === 'server' ? 'serverFinalStage' : step.title), index, phase, collapsed: !!layout.collapsed?.[id], toggle: () => layout.setCollapsed(current => ({ ...current, [id]: !current[id] })) } }]
    })
    const imageNodeIds = nodes.map(node => node.id).join('|'), [dragging, setDragging] = React.useState(false)
    React.useEffect(() => { if (!dragging && nodes.every(node => layout.measuredDimensions(node.id))) layout.reconcile(flow.current?.getViewport(), nodes.map(node => node.id)) }, [imageNodeIds, layout.geometryRevision, dragging])
    const edges: WorkflowEdge[] = imageWorkflowConnections(steps.map(step => step.stage), control.item, control.attempt).map(({ source, target }) => {
      const from = fixedImageWorkflowNodeId(lane, source), to = fixedImageWorkflowNodeId(lane, target)
      const data = nodes.find(node => node.id === to)!.data
      return { id: `direct-edge-${source}-${target}`, source: from, target: to, sourceHandle: 'out', targetHandle: 'in', type: 'workflow', data: { phase: data.upcoming ? 'queued' : data.phase, flowing: !data.upcoming && data.phase === 'running' } }
    })
    const rework = imageWorkflowRework(control.item, control.value && control.item ? wallpaperImageWorkStatus(control.value, control.item.imageVersionId) : 'created', control.attempt)
    const reviewNode = nodes.find(node => node.data.stage === 'reviewing'), renderNode = nodes.find(node => node.data.stage === 'rendering')
    if (rework && reviewNode && renderNode) edges.push({ id: 'direct-rework', source: reviewNode.id, target: renderNode.id, sourceHandle: 'return', targetHandle: 'rework', type: 'workflow', markerEnd: { type: MarkerType.ArrowClosed, color: rework.stage === 'rendering' ? 'var(--dsw-alias-state-error-primary)' : rework.stage === 'passed' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)' }, label: rework.stage === 'rendering' ? t('directCropRework') : rework.stage === 'passed' ? t('wallpaperPassed') : t('wallpaperStageReview') + ' · ' + t(workflowPhaseKeys[rework.phase]), data: { phase: rework.phase, rework: true, reworkStage: rework.stage, flowing: rework.flowing, returnY: -100, labelWidth: 180 } })
    return <div className="vc-direct-workflow">{control.value && <wallpaper.TaskStatus control={control} t={t} />}{!control.value && control.error && <p role="alert" className="vc-notice">{t('wallpaperFailed')}</p>}<div className="vc-workflow-surface" data-loading={navigationLoading || undefined} aria-busy={navigationLoading}><div className="vc-direct-flow" aria-hidden={navigationLoading || undefined}>
      <wallpaper.ImageNavigator control={control} t={t} onSelect={() => { restored.current = true }} />
      <div className="vc-workflow-canvas vc-direct-canvas"><ReactFlow<FlowNode, WorkflowEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={value => { flow.current = value }} fitView={!layout.initialViewport} fitViewOptions={{ padding: 0.15, maxZoom: 0.9 }} defaultViewport={layout.initialViewport ?? { x: 64, y: 100, zoom: 0.85 }} minZoom={0.15} maxZoom={1.5} nodesConnectable={false} deleteKeyCode={null} onNodesChange={changes => { for (const change of changes) { if (change.type === 'position' && change.position) layout.move(change.id, change.position); if (change.type === 'dimensions' && change.dimensions) layout.measure(change.id, change.dimensions) } }} onNodeDragStart={() => setDragging(true)} onNodeDragStop={() => { setDragging(false); layout.reconcile(flow.current?.getViewport(), nodes.map(node => node.id)) }} onMoveEnd={(_event, at) => layout.save(at)}>
        <Background gap={24} size={1} /><MiniMap pannable zoomable /><Panel position="bottom-left"><div className="vc-flow-toolbar"><wallpaper.StepHistory control={control} t={t} value={inspected} onChange={stage => { setHistory(control.item ? { image: control.item.imageVersionId, revision: control.attempt?.revision, stage } : undefined); if (stage) void flow.current?.fitView({ nodes: [{ id: fixedImageWorkflowNodeId(lane, stage) }], padding: 0.15, maxZoom: 1 }) }} /><div className="vc-flow-camera-controls"><ui.Button size="sm" variant="outline" aria-label={t('directCropZoomOut')} onClick={() => { void flow.current?.zoomOut({ duration: 220 }) }}>−</ui.Button><ui.Button size="sm" variant="outline" className="vc-flow-focus" onClick={() => { void flow.current?.fitView({ duration: 220, padding: 0.15 }) }}>{t('directCropRestore')}</ui.Button><ui.Button size="sm" variant="outline" aria-label={t('directCropZoomIn')} onClick={() => { void flow.current?.zoomIn({ duration: 220 }) }}>+</ui.Button></div><ui.Button size="sm" variant="outline" onClick={() => { layout.place(workflowStaggeredPositions(nodes.map(node => ({ id: node.id, width: node.measured?.width ?? 380 }))), true); requestAnimationFrame(() => { void flow.current?.fitView({ padding: 0.15, maxZoom: 0.9 }) }) }}>{t('workflowArrange')}</ui.Button></div></Panel>
      </ReactFlow></div>
      <wallpaper.Dialogs control={control} t={t} />
    </div>{navigationLoading && <div className="vc-canvas-loading" role="status" aria-label={t('wallpaperLoadingImage')}><ui.StateDot state="ongoing" size={18} /></div>}</div></div>
  }
}
