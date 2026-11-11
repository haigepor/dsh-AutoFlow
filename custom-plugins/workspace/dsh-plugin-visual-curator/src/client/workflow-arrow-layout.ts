/** Marching arrows occupy fixed distance bands; only endpoint opacity changes as density grows. */
export const FLOW_ARROW_LIMIT = 5

/** @param length Measured curve length in canvas pixels. @param spacing Preferred distance between arrows. @param period Milliseconds for forty pixels of travel. @returns A bounded pattern with one shared constant-speed cycle. */
export function workflowArrowLayout(length: number, spacing: number, period: number) {
  const pitch = Math.min(Math.max(1, length), Math.max(spacing, length / FLOW_ARROW_LIMIT))
  return { length, pitch, duration: pitch / 40 * period, count: Math.min(FLOW_ARROW_LIMIT, Math.ceil(length / pitch)) }
}

/** @param layout Measured curve and repeating distance band. @param index Stable arrow slot. @returns Native motion keyframes that fade before clamped path endpoints can overlap. */
export function workflowArrowFrames(layout: ReturnType<typeof workflowArrowLayout>, index: number) {
  const start = index * layout.pitch, end = start + layout.pitch, fade = Math.min(12, layout.length / 4)
  const distances = [...new Set([start, end, fade, layout.length - fade, layout.length].filter(at => at >= start && at <= end))].sort((a, b) => a - b)
  return distances.map(at => ({ offset: (at - start) / (end - start), offsetDistance: `${at}px`, opacity: at <= 0 || at >= layout.length ? 0 : Math.min(1, at / fade, (layout.length - at) / fade) }))
}
