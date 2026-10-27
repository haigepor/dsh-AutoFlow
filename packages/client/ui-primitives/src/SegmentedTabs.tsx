import type { KeyboardEvent, ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Pill } from './Pill.tsx'
import css from './SegmentedTabs.module.css'

/** A tab links its localized label to a caller-owned panel. */
export interface SegmentedTab<Value extends string = string> {
  value: Value
  label: ReactNode
  id: string
  panelId: string
  /** Unavailable tabs stay visible and are skipped by keyboard navigation. */
  disabled?: boolean
  /** Optional reason why a tab is unavailable. */
  title?: string | undefined
  /** Accessible name when the visible label is abbreviated. */
  ariaLabel?: string
}

/**
 * Render controlled tabs with a sliding selection indicator.
 * @param props.items - non-empty ordered tabs with unique values and DOM ids.
 * @param props.value - selected value, which must belong to items.
 * @param props.onChange - selection requested by click, Left/Right, or Home/End.
 * Keyboard selection also moves focus; only the selected tab is a tab stop.
 * @param props.label - localized accessible name for the tab list.
 * @param props.className - layout placement; panels remain caller-owned.
 * @param props.variant - equal-width segments by default, or content-width tabs with an underline.
 * @returns the tab list, without its panels.
 */
export function SegmentedTabs<Value extends string>({ items, value, onChange, label, className, variant = 'segmented' }: {
  items: readonly [SegmentedTab<Value>, ...SegmentedTab<Value>[]]
  value: Value
  onChange: (value: Value) => void
  label: string
  className?: string | undefined
  variant?: 'segmented' | 'underline' | undefined
}): ReactNode {
  const selectedIndex = items.findIndex(item => item.value === value)
  const rootRef = useRef<HTMLDivElement>(null)
  const [underline, setUnderline] = useState<{ left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (variant !== 'underline' || root === null) return
    const tabs = root.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    const measure = (): void => {
      const selected = tabs[selectedIndex]
      if (selected === undefined) return
      const container = root.getBoundingClientRect()
      const bounds = selected.getBoundingClientRect()
      const next = { left: bounds.left - container.left + root.scrollLeft, width: bounds.width }
      setUnderline(previous => previous?.left === next.left && previous.width === next.width ? previous : next)
    }
    // 标签宽度由字体和文案决定；同一观察器处理容器及字体尺寸变化。
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    for (const tab of tabs) observer.observe(tab)
    return () => { observer.disconnect() }
  }, [items, selectedIndex, variant])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const available = items.map((item, position) => ({ item, position })).filter(({ item }) => item.disabled !== true)
    if (available.length === 0) return
    const current = available.findIndex(item => item.position === index)
    let next: number
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp': next = (current + available.length - 1) % available.length; break
      case 'ArrowRight':
      case 'ArrowDown': next = (current + 1) % available.length; break
      case 'Home': next = 0; break
      case 'End': next = available.length - 1; break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    const tablist = event.currentTarget.parentElement
    const nextItem = available[next]
    /* v8 ignore next -- the event comes from a mounted direct child and next is bounded by non-empty items. */
    if (tablist === null || nextItem === undefined) return
    tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]').item(nextItem.position).focus()
    onChange(nextItem.item.value)
  }

  return (
    <div
      ref={rootRef}
      role="tablist"
      aria-label={label}
      className={clsx(css.tabs, variant === 'underline' && css.underline, className)}
      style={variant === 'segmented' ? { gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` } : undefined}
    >
      {(variant === 'segmented' || underline !== null) && <span
        className={css.indicator}
        aria-hidden="true"
        style={variant === 'underline' && underline !== null
          ? { width: `${underline.width}px`, transform: `translateX(${underline.left}px)` }
          : { width: `calc((100% - 8px) / ${items.length})`, transform: `translateX(${selectedIndex * 100}%)` }}
      />}
      {items.map((item, index) => (
        <Pill
          key={item.value}
          id={item.id}
          role="tab"
          className={css.tab}
          aria-selected={value === item.value}
          aria-controls={item.panelId}
          aria-label={item.ariaLabel}
          disabled={item.disabled}
          title={item.title}
          tabIndex={value === item.value ? 0 : -1}
          onClick={() => { onChange(item.value) }}
          onKeyDown={(event) => { onKeyDown(event, index) }}
        >
          {item.label}
        </Pill>
      ))}
    </div>
  )
}
