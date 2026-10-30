/** Fixed dot texture with moving, feathered regions; no temporal point pulse. */
const size = 214, step = 14, radius = .85

function smooth(value: number): number { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t) }

/** Continuous region positions, alternating diagonals only after merging.
 * @param seconds Animation time, paused while hidden.
 * @returns The two feather regions with bounded opacity and radius.
 */
export function loadingRegions(seconds: number) {
  const cycle = Math.floor(seconds / 10), part = seconds - cycle * 10
  const split = smooth((part - 2) / 2) * (1 - smooth((part - 6) / 2)), diagonal = cycle % 2 === 0 ? 1 : -1
  const x = size * (.5 + .14 * Math.sin(seconds * .74) + .055 * Math.sin(seconds * 1.31 + 1.4))
  const y = size * (.5 + .14 * Math.cos(seconds * .61 + .3) + .055 * Math.sin(seconds * 1.07 + 2.1))
  const offset = size * .23 * split, r = size * (.47 - .12 * split)
  return [{ x: x + offset, y: y + offset * diagonal, radius: r, weight: 1 }, { x: x - offset, y: y - offset * diagonal, radius: r, weight: split }]
}

/** Mount only the local raster animation, with fixed geometry and complete teardown.
 * A square drawing surface is oversampled; CSS owns the display size without layout measurement.
 * @param canvas Decorative canvas owned by the mounted card.
 * @returns Disposer for frames, visibility, media preference and theme observations.
 */
export function mountLoadingDots(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext('2d')
  if (!context) return () => {}
  canvas.width = size * 2; canvas.height = size * 2; context.setTransform(2, 0, 0, 2, 0, 0)
  const columns = Math.ceil(size / step), offset = (size - (columns - 1) * step) / 2
  const points = Array.from({ length: columns * columns }, (_, i) => ({ x: offset + i % columns * step, y: offset + Math.floor(i / columns) * step }))
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  let frame: number | undefined, last = 0, time = 0, painted = 0, stopped = false
  function paint() {
    if (!context) return
    context.clearRect(0, 0, size, size); context.fillStyle = getComputedStyle(canvas).color
    const fields = loadingRegions(time)
    for (const point of points) {
      let alpha = 0
      for (const field of fields) {
        const n = Math.min(1, Math.hypot(point.x - field.x, point.y - field.y) / field.radius)
        alpha = Math.max(alpha, (1 - n * n) ** 2 * field.weight)
      }
      if (alpha < .005) continue
      context.globalAlpha = alpha * .58; context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2); context.fill()
    }
    context.globalAlpha = 1
  }
  function tick(now: number) {
    frame = undefined
    if (stopped || document.hidden || reduced.matches) { last = 0; return }
    if (last) time += Math.min(100, now - last) / 1000 * 1.35
    last = now
    if (now - painted >= 16) { paint(); painted = now }
    frame = requestAnimationFrame(tick)
  }
  function update() {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined; last = 0; paint()
    if (!stopped && !document.hidden && !reduced.matches) frame = requestAnimationFrame(tick)
  }
  const theme = new MutationObserver(paint)
  theme.observe(document.documentElement, { attributes: true })
  theme.observe(document.body, { attributes: true })
  document.addEventListener('visibilitychange', update); reduced.addEventListener('change', update); update()
  return () => { stopped = true; if (frame !== undefined) cancelAnimationFrame(frame); theme.disconnect(); document.removeEventListener('visibilitychange', update); reduced.removeEventListener('change', update) }
}
