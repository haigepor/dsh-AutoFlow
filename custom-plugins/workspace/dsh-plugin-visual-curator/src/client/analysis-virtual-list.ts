/** Variable-height transcript rows share the existing application virtualizer without bundling React. */
import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from '@tanstack/virtual-core'

/**
 * Bind measured transcript rows to the caller's React runtime and scroll region.
 * @param React React instance supplied by the owning Host.
 * @returns A hook whose stable response identities retain measured heights during live output.
 */
export function createAnalysisVirtualList(React: typeof import('react')) {
  return function useAnalysisVirtualList(scroll: React.RefObject<HTMLDivElement>, list: React.RefObject<HTMLDivElement>, runId: string, sequences: readonly number[], enabled: boolean, followEnd: boolean) {
    const [, render] = React.useReducer((revision: number) => revision + 1, 0)
    const keys = React.useRef(sequences)
    keys.current = sequences
    const [margin, setMargin] = React.useState(0)
    const getScrollElement = React.useCallback(() => scroll.current, [scroll])
    const getItemKey = React.useCallback((index: number) => keys.current[index] ?? index, [])
    const virtualizer = React.useMemo(() => new Virtualizer<HTMLDivElement, HTMLDivElement>({ count: 0, getScrollElement, estimateSize: () => 2800, scrollToFn: elementScroll, observeElementOffset, observeElementRect }), [runId, getScrollElement])
    virtualizer.setOptions({ ...virtualizer.options, count: sequences.length, getScrollElement, getItemKey, scrollMargin: margin, enabled, overscan: 2, anchorTo: followEnd ? 'end' : 'start', followOnAppend: followEnd, scrollEndThreshold: 64, onChange: () => render() })
    React.useLayoutEffect(() => virtualizer._didMount(), [virtualizer])
    React.useLayoutEffect(() => {
      virtualizer._willUpdate()
      const scroller = scroll.current, content = list.current
      if (!enabled || !scroller || !content) return
      // Streaming can resize a mounted row before ResizeObserver updates the sizer.
      // Measure this bounded window before the dialog restores its scroll position.
      for (const element of virtualizer.elementsCache.values()) {
        if (element.isConnected) virtualizer.resizeItem(virtualizer.indexFromElement(element), element.offsetHeight)
      }
      const next = content.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      if (Math.abs(next - margin) > 1) setMargin(next)
    })
    return { virtualizer, rows: virtualizer.getVirtualItems(), size: virtualizer.getTotalSize(), margin }
  }
}
