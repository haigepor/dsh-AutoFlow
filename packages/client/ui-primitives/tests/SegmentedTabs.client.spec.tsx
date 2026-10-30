// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SegmentedTabs } from '../src/SegmentedTabs.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const items = [
  { value: 'details', label: 'Details', id: 'details-tab', panelId: 'details-panel' },
  { value: 'examples', label: 'Examples', id: 'examples-tab', panelId: 'examples-panel' },
  { value: 'limits', label: 'Limits', id: 'limits-tab', panelId: 'limits-panel' },
] as const

describe('SegmentedTabs', () => {
  it('skips unavailable methods and exposes their reason and accessible name', () => {
    const onChange = vi.fn()
    render(<SegmentedTabs items={[items[0], { ...items[1], disabled: true, title: 'Unavailable' },
      { ...items[2], ariaLabel: 'Usage limits' }]} value="details" onChange={onChange} label="Help" />)
    const disabled = screen.getByRole<HTMLButtonElement>('tab', { name: 'Examples' })
    expect(disabled.disabled).toBe(true)
    expect(disabled.title).toBe('Unavailable')
    fireEvent.click(disabled)
    expect(onChange).not.toHaveBeenCalled()
    const first = screen.getByRole('tab', { name: 'Details' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Usage limits' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('limits')
  })

  it('fits one underline to the selected label and follows selection and resized labels', () => {
    let resized: (() => void) | undefined
    let examplesWidth = 90
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe() {}
      disconnect = disconnect
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.id === 'details-tab') return new DOMRect(108, 0, 64, 25)
      if (this.id === 'examples-tab') return new DOMRect(208, 0, examplesWidth, 25)
      return new DOMRect(100, 0, 350, 25)
    })
    const view = render(<SegmentedTabs variant="underline" items={items} value="details" onChange={() => {}} label="Help" />)
    const indicator = () => screen.getByRole('tablist').querySelector<HTMLElement>('[aria-hidden="true"]')!
    expect(indicator().style.width).toBe('64px')
    expect(indicator().style.transform).toBe('translateX(8px)')
    view.rerender(<SegmentedTabs variant="underline" items={items} value="examples" onChange={() => {}} label="Help" />)
    expect(indicator().style.width).toBe('90px')
    expect(indicator().style.transform).toBe('translateX(108px)')
    examplesWidth = 114
    act(() => { resized?.() })
    expect(indicator().style.width).toBe('114px')
    disconnect.mockClear()
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('requests a selection while the caller owns its value and panels', () => {
    const onChange = vi.fn()
    const { rerender } = render(<SegmentedTabs items={items} value="details" onChange={onChange} label="Help" />)
    const examples = screen.getByRole('tab', { name: 'Examples' })
    fireEvent.click(examples)
    expect(onChange).toHaveBeenCalledWith('examples')
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Details')
    expect(screen.queryByRole('tabpanel')).toBeNull()

    rerender(<SegmentedTabs items={items} value="examples" onChange={onChange} label="Help" />)
    expect(examples.getAttribute('aria-selected')).toBe('true')
    expect(examples.id).toBe('examples-tab')
    expect(examples.getAttribute('aria-controls')).toBe('examples-panel')
    expect(examples.tabIndex).toBe(0)
    expect(screen.getByRole('tab', { name: 'Details' }).tabIndex).toBe(-1)
    expect(screen.getByRole('tablist', { name: 'Help' })).toBeTruthy()
  })

  it.each(['sm', 'md'] as const)('%s moves focus and selection with arrows, Home, and End, and leaves Tab alone', (size) => {
    const onKeyDown = vi.fn()
    function Harness() {
      const [value, setValue] = useState<string>('details')
      return <div onKeyDown={onKeyDown}><SegmentedTabs size={size} items={items} value={value} onChange={setValue} label="Help" /></div>
    }
    render(<Harness />)
    const details = screen.getByRole('tab', { name: 'Details' })
    const examples = screen.getByRole('tab', { name: 'Examples' })
    const limits = screen.getByRole('tab', { name: 'Limits' })
    details.focus()
    for (const [from, key, to] of [
      [details, 'ArrowLeft', limits],
      [limits, 'ArrowRight', details],
      [details, 'ArrowRight', examples],
      [examples, 'End', limits],
      [limits, 'Home', details],
    ] as const) {
      fireEvent.keyDown(from, { key })
      expect(document.activeElement).toBe(to)
      expect(to.getAttribute('aria-selected')).toBe('true')
      expect(to.tabIndex).toBe(0)
    }
    expect(onKeyDown).not.toHaveBeenCalled()
    fireEvent.keyDown(details, { key: 'Tab' })
    expect(onKeyDown).toHaveBeenCalledOnce()
    expect(screen.getByRole('tab', { selected: true })).toBe(details)
  })
})
