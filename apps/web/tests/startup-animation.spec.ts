// @vitest-environment jsdom
/** Startup presentation observes independent playback, mount, and data arrival. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startStartupAnimation, type StartupAnimation } from '../src/startup-animation.ts'

let animation: StartupAnimation | undefined
const play = vi.fn<() => Promise<void>>()

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('__DSH_STARTUP_ANIMATION__', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  document.body.innerHTML = '<div id="root"></div>'
  play.mockReset().mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})

afterEach(() => {
  animation?.dispose()
  animation = undefined
  document.documentElement.removeAttribute('data-dsh-startup-state')
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function start(): HTMLVideoElement {
  animation = startStartupAnimation(document, '/assets/cyberpunk.mp4')
  return document.querySelector('video')!
}

it('starts before application mount and keeps the underlying mount point available', () => {
  const video = start()
  expect(video.getAttribute('src')).toBe('/assets/cyberpunk.mp4')
  expect(video.muted && video.autoplay && video.playsInline).toBe(true)
  expect(document.getElementById('root')).not.toBeNull()
  expect(document.getElementById('root')?.inert).toBe(true)
  expect(play).toHaveBeenCalledOnce()
})

it('plays to the end when mount and the initial data arrive first', async () => {
  const video = start()
  document.documentElement.setAttribute('data-dsh-startup-state', 'ready')
  animation!.mounted()
  await Promise.resolve()
  expect(document.querySelector('[data-dsh-startup-animation="playing"]')).not.toBeNull()
  video.dispatchEvent(new Event('ended'))
  await vi.advanceTimersByTimeAsync(500)
  expect(document.querySelector('[data-dsh-startup-animation]')).toBeNull()
  expect(document.getElementById('root')?.inert).toBe(false)
  expect(video.hasAttribute('src')).toBe(false)
})

it('holds the final frame until both mount and initial-data readiness arrive', async () => {
  const video = start()
  document.documentElement.setAttribute('data-dsh-startup-state', 'loading')
  video.dispatchEvent(new Event('ended'))
  await vi.advanceTimersByTimeAsync(1_000)
  expect(document.querySelector('[data-dsh-startup-animation="waiting"]')).not.toBeNull()
  document.documentElement.setAttribute('data-dsh-startup-state', 'ready')
  await Promise.resolve()
  expect(document.querySelector('[data-dsh-startup-animation="waiting"]')).not.toBeNull()
  animation!.mounted()
  await vi.advanceTimersByTimeAsync(500)
  expect(document.querySelector('[data-dsh-startup-animation]')).toBeNull()
})

it.each(['skip', 'escape', 'error', 'failure', 'timeout'] as const)('reveals the application after %s without claiming it is ready', async (reason) => {
  const video = start()
  document.documentElement.setAttribute('data-dsh-startup-state', 'loading')
  if (reason === 'skip') document.querySelector('button')!.click()
  else if (reason === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  else if (reason === 'error') video.dispatchEvent(new Event('error'))
  else if (reason === 'failure') animation!.fail()
  else await vi.advanceTimersByTimeAsync(30_000)
  await vi.advanceTimersByTimeAsync(500)
  expect(document.querySelector('[data-dsh-startup-animation]')).toBeNull()
  expect(document.getElementById('root')?.inert).toBe(false)
  expect(document.documentElement.getAttribute('data-dsh-startup-state')).toBe('loading')
  expect(vi.getTimerCount()).toBe(0)
})

it.each([undefined, false])('does not create media before mount when activation is %s', (enabled) => {
  vi.stubGlobal('__DSH_STARTUP_ANIMATION__', enabled)
  animation = startStartupAnimation(document, '/assets/cyberpunk.mp4')
  expect(document.querySelector('video')).toBeNull()
  expect(document.querySelector('[data-dsh-startup-animation]')).toBeNull()
  expect(document.getElementById('root')?.inert).not.toBe(true)
  expect(play).not.toHaveBeenCalled()
})

it('reveals the existing application when an expected startup plugin never publishes its baseline', async () => {
  start()
  animation!.mounted()
  await vi.advanceTimersByTimeAsync(500)
  expect(document.querySelector('[data-dsh-startup-animation]')).toBeNull()
})

it('honors reduced motion without creating media or blocking the application', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  animation = startStartupAnimation(document, '/assets/cyberpunk.mp4')
  animation.mounted()
  expect(document.querySelector('video')).toBeNull()
  expect(document.getElementById('root')?.inert).not.toBe(true)
  expect(play).not.toHaveBeenCalled()
})
