// @vitest-environment jsdom
/** Provider setup follows the Settings animation and cancels pending work on teardown. */
import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useProviderPageTransition } from '../src/client/useProviderPageTransition.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

function Harness({ duration = '0.175s' }: { duration?: string }) {
  const root = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState('catalog')
  const motion = useProviderPageTransition(root)
  return <div ref={root}><div data-models-subpage data-leaving={motion.leaving} style={{ animationDuration: duration }}>
    <span>{page}</span><button onClick={() => { motion.transition(() => { setPage('setup') }) }}>Open setup</button>
  </div></div>
}

it('finishes the existing exit animation before replacing the page and clears its timer on unmount', () => {
  vi.useFakeTimers()
  const view = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Open setup' }))
  expect(screen.queryByText('setup')).toBeNull()
  act(() => { vi.advanceTimersByTime(174) })
  expect(screen.getByText('catalog')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(1) })
  expect(screen.getByText('setup')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open setup' }))
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('replaces immediately when the Settings page has no animation', () => {
  render(<Harness duration="0s" />)
  fireEvent.click(screen.getByRole('button', { name: 'Open setup' }))
  expect(screen.getByText('setup')).toBeTruthy()
})
