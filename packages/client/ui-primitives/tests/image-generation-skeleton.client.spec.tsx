// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ImageGenerationSkeleton } from '../src/ImageGenerationSkeleton.tsx'
import { loadingRegions } from '../src/image-loading-dots.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('steady regions retain their radius while moving or holding a split', () => {
  for (const [start, end] of [[0, 2], [4, 6], [8, 10]] as const) {
    const radius = loadingRegions(start)[0]?.radius
    for (let time = start; time < end; time += .1) for (const field of loadingRegions(time)) expect(field.radius).toBe(radius)
  }
})

it('task pause, reduced motion, page visibility and unmount release animation frames', () => {
  const frames = new Map<number, FrameRequestCallback>(), changes = new Set<() => void>()
  let sequence = 0, reduced = false, hidden = false
  vi.stubGlobal('requestAnimationFrame', (work: FrameRequestCallback) => { frames.set(++sequence, work); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced }, addEventListener: (_: string, work: () => void) => changes.add(work), removeEventListener: (_: string, work: () => void) => changes.delete(work) }))
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  const drawing = { setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, fillStyle: '', globalAlpha: 1 }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(vi.fn().mockReturnValue(drawing))
  const view = render(<ImageGenerationSkeleton />)
  expect(frames.size).toBe(1)
  view.rerender(<ImageGenerationSkeleton active={false} />)
  expect(frames.size).toBe(0)
  view.rerender(<ImageGenerationSkeleton />)
  expect(frames.size).toBe(1)
  hidden = true; document.dispatchEvent(new Event('visibilitychange'))
  expect(frames.size).toBe(0)
  hidden = false; reduced = true; changes.forEach((work) => { work() })
  expect(frames.size).toBe(0)
  reduced = false; changes.forEach((work) => { work() })
  expect(frames.size).toBe(1)
  view.unmount()
  expect(frames.size).toBe(0); expect(changes.size).toBe(0)
  document.dispatchEvent(new Event('visibilitychange'))
  expect(frames.size).toBe(0)
})
