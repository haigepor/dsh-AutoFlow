import { PREVIEW_ANIMATION_DEFAULTS } from '../shared/afp-preview-animation-options.js'

/** Build an AFP shimmer placeholder that pauses when its preview is not visible.
 * @param {object} React Existing client React runtime.
 * @returns {Function} Local loading component; never owns media reads.
 */
export function createPreviewLoading(React) {
  const h = React.createElement
  return function PreviewLoading({ label, animation = PREVIEW_ANIMATION_DEFAULTS }) {
    const frame = React.useRef(null)
    React.useEffect(() => {
      const element = frame.current
      if (!element) return
      const document = element.ownerDocument, Observer = document.defaultView?.IntersectionObserver
      let visible = !Observer
      const update = () => element.setAttribute('data-active', String(visible && !document.hidden))
      const observer = Observer ? new Observer(changes => {
        for (const change of changes) if (change.target === element) visible = change.isIntersecting
        update()
      }) : undefined
      document.addEventListener('visibilitychange', update)
      update(); observer?.observe(element)
      return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update) }
    }, [])
    return h('span', { ref: frame, className: 'afp-skeleton afp-wb-image-skeleton', role: 'status', 'aria-label': label,
      'data-animation-enabled': animation.enabled },
      h('span', { className: 'afp-wb-preview-loading', 'aria-hidden': true },
        h('svg', { className: 'afp-wb-preview-placeholder', viewBox: '0 0 40 40', fill: 'none', stroke: 'currentColor' },
          h('rect', { x: 6, y: 7, width: 28, height: 26, rx: 5 }),
          h('circle', { cx: 15, cy: 16, r: 2.5 }),
          h('path', { d: 'm7 28 8-8 6 6 4-4 8 9', strokeLinecap: 'round', strokeLinejoin: 'round' })),
        h('span', { className: 'afp-wb-preview-shimmer' })))
  }
}
