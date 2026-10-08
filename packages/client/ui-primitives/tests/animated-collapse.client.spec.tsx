// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnimatedCollapse } from '../src/AnimatedCollapse.tsx'

it('retains closed form controls and their DOM selection when keepMounted is enabled', () => {
  const { rerender } = render(<AnimatedCollapse open keepMounted><textarea defaultValue="saved answer" /></AnimatedCollapse>)
  const field = screen.getByRole<HTMLTextAreaElement>('textbox')
  field.setSelectionRange(2, 6)
  rerender(<AnimatedCollapse open={false} keepMounted><textarea defaultValue="saved answer" /></AnimatedCollapse>)
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(field.isConnected).toBe(true)
  expect(field.closest('[inert]')).not.toBeNull()
  rerender(<AnimatedCollapse open keepMounted><textarea defaultValue="saved answer" /></AnimatedCollapse>)
  expect(screen.getByRole('textbox')).toBe(field)
  expect(field.selectionStart).toBe(2)
  expect(field.selectionEnd).toBe(6)
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('AnimatedCollapse', () => {
  it('mounts lazily and makes closing controls inert before releasing them', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ transitionDuration: '0.3s', transitionDelay: '0s' } as CSSStyleDeclaration)
    vi.useFakeTimers()
    const view = render(<AnimatedCollapse open={false}><button>Preview</button></AnimatedCollapse>)
    expect(view.queryByText('Preview')).toBeNull()
    view.rerender(<AnimatedCollapse open><button>Preview</button></AnimatedCollapse>)
    expect(view.getByRole('button')).toBeTruthy()
    view.rerender(<AnimatedCollapse open={false}>{undefined}</AnimatedCollapse>)
    expect(view.queryByRole('button')).toBeNull()
    expect(view.getByText('Preview').closest('[inert]')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(350) })
    expect(view.queryByText('Preview')).toBeNull()
  })

  it('reverses an unfinished exit without losing mounted content', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ transitionDuration: '0.3s', transitionDelay: '0s' } as CSSStyleDeclaration)
    vi.useFakeTimers()
    const child = <input defaultValue="draft" />
    const view = render(<AnimatedCollapse open>{child}</AnimatedCollapse>)
    const box = view.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'kept draft' } })
    view.rerender(<AnimatedCollapse open={false}>{child}</AnimatedCollapse>)
    view.rerender(<AnimatedCollapse open>{child}</AnimatedCollapse>)
    act(() => { vi.advanceTimersByTime(350) })
    expect(view.getByRole('textbox')).toBe(box)
    expect(box).toHaveProperty('value', 'kept draft')
  })

  it('releases closed content immediately when CSS disables transitions', () => {
    const view = render(<AnimatedCollapse open><span>Content</span></AnimatedCollapse>)
    view.rerender(<AnimatedCollapse open={false}><span>Content</span></AnimatedCollapse>)
    expect(view.queryByText('Content')).toBeNull()
  })
})
