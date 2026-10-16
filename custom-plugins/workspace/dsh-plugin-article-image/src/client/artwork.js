/** Theme-colored editorial artwork; the generated brand asset stays separate. */

/** Create the small navigation mark and scalable workflow illustration. @param {object} React Shared runtime. @returns {object} Decorative components. */
export function createArtwork(React) {
  const h = React.createElement
  function Mark({ size = 20, className }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', className, 'aria-hidden': true },
      h('path', { d: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9L14 3Z M14 3v6h6 M8 8h3 M8 11h3 M7 18l4-4 3 3 2-2 2 3' }), h('circle', { cx: 16, cy: 12, r: 1, fill: 'currentColor', stroke: 'none' }))
  }
  function Illustration({ kind = 'article', animated = false }) {
    return h('svg', { className: 'ai-illustration', 'data-animated': animated, viewBox: '0 0 240 144', fill: 'none', 'aria-hidden': true },
      h('ellipse', { cx: 120, cy: 125, rx: 81, ry: 8, className: 'ai-art-ground' }),
      h('g', { className: 'ai-art-back', transform: 'rotate(-9 88 73)' }, h('rect', { x: 46, y: 24, width: 76, height: 94, rx: 9, className: 'ai-art-paper' }),
        h('path', { d: 'M61 44h42M61 54h34M61 64h39M61 81h24M61 91h34M61 101h20', className: 'ai-art-lines', strokeWidth: 3, strokeLinecap: 'round' })),
      h('g', { className: 'ai-art-front', transform: 'rotate(6 151 79)' }, h('rect', { x: 100, y: 40, width: 96, height: 76, rx: 9, className: 'ai-art-paper' }),
        h('rect', { x: 108, y: 48, width: 80, height: 60, rx: 5, className: 'ai-art-window' }),
        h('path', { d: 'M110 101l23-25 19 20 13-12 21 23h-76Z', className: 'ai-art-mountain' }),
        h('circle', { cx: 169, cy: 66, r: 7, className: 'ai-art-sun' })),
      h('path', { d: kind === 'prompts' ? 'M198 18v14M191 25h14M32 87v8M28 91h8' : 'M188 20v10M183 25h10M31 87v8M27 91h8', className: 'ai-art-spark', strokeWidth: 2, strokeLinecap: 'round' }),
      h('path', { d: 'M120 19c13-6 24-4 31 2m-6-7 7 7-9 2', className: 'ai-art-lines ai-art-arrow', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
  }
  return { Mark, Illustration }
}
