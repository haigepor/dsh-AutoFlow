/** @jsxRuntime classic */
/** @jsx React.createElement */
/** Native SVG motion follows a stable Bézier path without React frame updates. */
import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import type { WorkflowPhase } from './workflow-node-state.ts'

/** Status follows the destination; flow can also represent active upstream input. */
export type WorkflowEdge = Edge<{ phase: WorkflowPhase; rework?: boolean; flowing?: boolean }, 'workflow'>

/** @param React Shared runtime. @returns A stable edge renderer with native SVG arrow markers. */
export function createWorkflowEdge(React: typeof import('react')) {
  return React.memo(function WorkflowWire({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, label }: EdgeProps<WorkflowEdge>) {
    const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.3 })
    const phase = data?.phase ?? 'idle'
    const root = React.useRef<SVGGElement>(null), [duration, setDuration] = React.useState(0), [motion, setMotion] = React.useState(false)
    const flowing = data?.flowing ?? phase === 'running'
    React.useLayoutEffect(() => {
      if (!root.current) return
      const token = getComputedStyle(root.current).getPropertyValue('--ds-transition-duration-slow').trim(), match = /^(\d*\.?\d+)(ms|s)$/.exec(token)
      if (match) setDuration(Number(match[1]) * (match[2] === 's' ? 1000 : 1) * 10)
    }, [])
    React.useEffect(() => {
      const preference = window.matchMedia('(prefers-reduced-motion: reduce)'), update = () => setMotion(!preference.matches && !document.hidden)
      update(); preference.addEventListener('change', update); document.addEventListener('visibilitychange', update)
      return () => { preference.removeEventListener('change', update); document.removeEventListener('visibilitychange', update) }
    }, [])
    return <g ref={root} className="vc-workflow-wire" data-phase={phase} data-flowing={flowing || undefined} data-rework={data?.rework || undefined}>
      <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} interactionWidth={16} className="vc-workflow-wire-path" />
      {flowing && motion && duration > 0 && <g className="vc-workflow-particles" aria-hidden="true">{[0, 1, 2].map(index => <circle key={index} r={index === 0 ? 2.6 : 1.8} opacity={1 - index * 0.2} className="vc-workflow-particle"><animateMotion dur={`${duration}ms`} begin={`${-index * duration / 3}ms`} repeatCount="indefinite" rotate="auto"><mpath href={`#${id}`} /></animateMotion></circle>)}</g>}
      {label && <text className="vc-workflow-wire-label" x={labelX} y={labelY - 10} textAnchor="middle">{label}</text>}
    </g>
  })
}
