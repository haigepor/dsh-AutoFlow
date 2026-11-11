/** @jsxRuntime classic */
/** @jsx React.createElement */
/** Edge geometry updates independently of the native animation timeline. */
import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import type { WorkflowPhase } from './workflow-node-state.ts'
import { FLOW_ARROW_LIMIT, workflowArrowFrames, workflowArrowLayout } from './workflow-arrow-layout.ts'
import { workflowReturnPath } from './workflow-return-layout.ts'

/** Status follows the destination; the canvas epoch restores motion after viewport culling. */
export type WorkflowEdge = Edge<{ phase: WorkflowPhase; rework?: boolean; reworkStage?: 'rendering' | 'reviewing' | 'passed'; flowing?: boolean; motionEpoch?: number; labelWidth?: number; returnY?: number }, 'workflow'>

/** @param React Shared runtime. @returns Stable edges with continuous native SVG flow. */
export function createWorkflowEdge(React: typeof import('react')) {
  return React.memo(function WorkflowWire({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, label }: EdgeProps<WorkflowEdge>) {
    const [path, labelX, labelY] = data?.returnY === undefined ? getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.3 }) : workflowReturnPath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, data.returnY)
    const phase = data?.phase ?? 'idle', flowing = data?.flowing ?? phase === 'running', enabled = flowing || phase === 'paused'
    const labelWidth = data?.labelWidth ?? Math.max(72, Math.min(180, Math.abs(targetX - sourceX) - 24))
    const labelOpacity = data?.labelWidth ? Math.max(0, Math.min(1, Math.max(Math.abs(targetX - sourceX) - labelWidth - 24, Math.abs(targetY - sourceY) - 80) / 32)) : 0
    const root = React.useRef<SVGGElement>(null), glint = React.useRef<SVGPathElement>(null), animation = React.useRef<Animation | null>(null), arrows = React.useRef<Animation[]>([])
    const [accents] = React.useState(() => Array.from({ length: FLOW_ARROW_LIMIT }, () => React.createRef<SVGGElement>()))
    const arrowPath = React.useRef(''), arrowDuration = React.useRef(1), flowDuration = React.useRef(900), spacing = React.useRef(144)
    const running = React.useRef(flowing), playback = React.useRef<(() => void) | null>(null)
    running.current = flowing
    React.useLayoutEffect(() => {
      if (!enabled || !glint.current || accents.some(ref => !ref.current)) return
      const element = glint.current, preference = window.matchMedia('(prefers-reduced-motion: reduce)')
      const duration = Number(getComputedStyle(element).getPropertyValue('--vc-workflow-flow-duration')) || 900
      spacing.current = Number(getComputedStyle(element).getPropertyValue('--vc-workflow-arrow-spacing')) || 144
      flowDuration.current = duration
      const motion = animation.current ?? element.animate([{ strokeDashoffset: '0' }, { strokeDashoffset: '-40' }], { duration, iterations: Infinity, easing: 'linear' })
      if (!animation.current) motion.currentTime = Math.max(0, performance.now() - (data?.motionEpoch ?? performance.now()))
      animation.current = motion
      if (!arrows.current.length) {
        const layout = workflowArrowLayout(element.getTotalLength(), spacing.current, duration)
        arrowDuration.current = layout.duration
        root.current?.setAttribute('data-arrow-count', String(layout.count))
        arrows.current = accents.map((ref, index) => {
          const travelling = ref.current!.animate(workflowArrowFrames(layout, index), { duration: layout.duration, iterations: Infinity, easing: 'linear' })
          travelling.currentTime = Number(motion.currentTime ?? 0) % layout.duration
          return travelling
        })
        arrowPath.current = path
      }
      const travelling = arrows.current, decorations = accents.map(ref => ref.current!)
      const update = () => {
        const active = running.current && !preference.matches && !document.hidden
        if (active) { motion.play(); for (const arrow of travelling) arrow.play() } else { motion.pause(); for (const arrow of travelling) arrow.pause() }
        element.style.visibility = active ? 'visible' : 'hidden'
        for (const decoration of decorations) decoration.style.visibility = active ? 'visible' : 'hidden'
      }
      playback.current = update; update()
      preference.addEventListener('change', update); document.addEventListener('visibilitychange', update)
      return () => { motion.pause(); for (const arrow of travelling) arrow.pause(); playback.current = null; element.style.visibility = 'hidden'; for (const decoration of decorations) decoration.style.visibility = 'hidden'; preference.removeEventListener('change', update); document.removeEventListener('visibilitychange', update) }
    }, [enabled])
    React.useLayoutEffect(() => () => { animation.current?.cancel(); for (const arrow of arrows.current) arrow.cancel(); animation.current = null; arrows.current = [] }, [])
    React.useLayoutEffect(() => { playback.current?.() }, [flowing])
    React.useLayoutEffect(() => {
      if (!arrows.current.length || !glint.current || arrowPath.current === path) return
      const elapsed = Number(arrows.current[0]!.currentTime ?? 0) % arrowDuration.current
      const layout = workflowArrowLayout(glint.current.getTotalLength(), spacing.current, flowDuration.current)
      arrowDuration.current = layout.duration
      root.current?.setAttribute('data-arrow-count', String(layout.count))
      arrows.current.forEach((arrow, index) => {
        (arrow.effect as KeyframeEffect).setKeyframes(workflowArrowFrames(layout, index))
        arrow.effect!.updateTiming({ duration: layout.duration }); arrow.currentTime = elapsed
      })
      arrowPath.current = path
    }, [path, enabled])
    return <g ref={root} className="vc-workflow-wire" data-phase={phase} data-flowing={flowing || undefined} data-rework={data?.rework || undefined} data-rework-stage={data?.reworkStage}>
      <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} interactionWidth={16} className="vc-workflow-wire-path" />
      <path ref={glint} d={path} className="vc-workflow-glint" aria-hidden="true" />
      {accents.map((ref, index) => <g key={index} ref={ref} className="vc-workflow-flow-accent" style={{ offsetPath: `path('${path}')`, offsetRotate: 'auto', offsetAnchor: '0px 0px', offsetPosition: '0px 0px' }} aria-hidden="true"><path className="vc-workflow-arrow-underlay" d="M -11 0 H 0 M -4 -3 L 0 0 L -4 3" /><path d="M -11 0 H 0 M -4 -3 L 0 0 L -4 3" /></g>)}
      {label && (data?.rework ? <foreignObject x={labelX - labelWidth / 2} y={labelY - 30} width={labelWidth} height={28} style={{ opacity: labelOpacity }} pointerEvents="none"><div className="vc-workflow-rework-label">{label}</div></foreignObject> : <text className="vc-workflow-wire-label" x={labelX} y={labelY - 10} textAnchor="middle">{label}</text>)}
    </g>
  })
}
