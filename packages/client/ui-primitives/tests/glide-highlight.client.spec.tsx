// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { GlideHighlight } from '../src/GlideHighlight.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mount(bridgeGaps = false) {
  const view = render(<nav>
    <GlideHighlight className="highlight" rowSelector="button" bridgeGaps={bridgeGaps} />
    <button>Appearance</button><h2>Models and agents</h2><button>Models</button>
  </nav>)
  const nav = screen.getByRole('navigation')
  const rows = [screen.getByRole('button', { name: 'Appearance' }), screen.getByRole('button', { name: 'Models' })] as const
  for (const [element, top, height] of [[nav, 0, 240], [rows[0], 100, 32], [rows[1], 200, 32]] as const) {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 240, height))
  }
  const layer = view.container.querySelector<HTMLElement>('.highlight')!
  const move = (element: HTMLElement, y: number) => {
    fireEvent(element, new MouseEvent('pointermove', { bubbles: true, clientY: y }))
  }
  return { nav, rows, layer, move, heading: screen.getByRole('heading') }
}

it('bridges a category gap in both directions without hiding or selecting a row', () => {
  const { nav, rows, layer, heading, move } = mount(true)
  fireEvent.pointerOver(rows[0])
  move(heading, 180)
  expect(layer.style.top).toBe('200px')
  expect(layer.style.opacity).toBe('1')
  expect(nav.dataset.glideActive).toBe('true')
  expect(document.activeElement).not.toBe(rows[1])
  move(heading, 145)
  expect(layer.style.top).toBe('100px')
})

it('keeps gap bridging opt-in and starts only after entering a row', () => {
  const { rows, layer, heading, move } = mount()
  move(heading, 180)
  expect(layer.style.opacity).not.toBe('1')
  fireEvent.pointerOver(rows[0])
  move(heading, 180)
  expect(layer.style.top).toBe('100px')
})

it('restores keyboard focus on pointer leave and resets pointer tracking on scroll', () => {
  const { nav, rows, layer, heading, move } = mount(true)
  rows[0].focus()
  fireEvent.pointerOver(rows[1])
  fireEvent.pointerLeave(nav)
  expect(layer.style.top).toBe('100px')
  fireEvent.pointerOver(rows[1])
  fireEvent.scroll(nav)
  move(heading, 180)
  expect(layer.style.top).toBe('100px')
})
