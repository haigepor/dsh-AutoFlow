/** Cancel a strip transition without changing the reader's current position.
 * @param {object} motion Per-strip animation state.
 */
export function cancelPhotoScroll(motion) {
  if (motion.frame !== undefined) cancelAnimationFrame(motion.frame)
  if (motion.node) motion.node.style.scrollSnapType = motion.snap ?? ''
  motion.frame = undefined
  motion.node = undefined
  motion.target = undefined
}

/** Move one card with reversible easing; repeated clicks advance the pending destination.
 * @param {HTMLElement} node Photo-strip viewport.
 * @param {number} direction Previous (-1) or next (1).
 * @param {object} motion Per-strip state disposed when the gallery closes.
 */
export function slidePhotoStrip(node, direction, motion) {
  const origin = node.children[0]?.offsetLeft ?? 0
  const positions = Array.from(node.children, child => child.offsetLeft - origin)
  const base = motion.target ?? node.scrollLeft
  const next = direction > 0 ? positions.find(left => left > base + 1)
    : positions.reverse().find(left => left < base - 1)
  const target = Math.max(0, Math.min(next ?? (direction > 0 ? node.scrollWidth - node.clientWidth : 0), node.scrollWidth - node.clientWidth))
  cancelPhotoScroll(motion)
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduced || typeof requestAnimationFrame !== 'function') {
    node.scrollTo({ left: target, behavior: reduced ? 'auto' : 'smooth' })
    return
  }
  const token = getComputedStyle(node).getPropertyValue('--ds-transition-duration-slow').trim()
  const value = Number.parseFloat(token)
  const duration = Number.isFinite(value) ? value * (token.endsWith('ms') ? 1 : 1000) : 300
  const from = node.scrollLeft
  if (duration <= 0 || from === target) { node.scrollTo({ left: target, behavior: 'instant' }); return }
  motion.target = target
  motion.node = node
  motion.snap = node.style.scrollSnapType
  node.style.scrollSnapType = 'none'
  let started
  const tick = timestamp => {
    started ??= timestamp
    const progress = Math.min(1, (timestamp - started) / duration)
    const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
    node.scrollTo({ left: from + (target - from) * eased, behavior: 'instant' })
    if (progress < 1) motion.frame = requestAnimationFrame(tick)
    else cancelPhotoScroll(motion)
  }
  motion.frame = requestAnimationFrame(tick)
}
