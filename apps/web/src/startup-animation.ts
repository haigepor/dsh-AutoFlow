/** Early startup presentation, independent of Host and client plugin activation. */
import './startup-animation.css'
import { startupCopy } from './locales.ts'

declare global {
  interface Window {
    /** Active Host plugin or Desktop profile permits early startup media. */
    __DSH_STARTUP_ANIMATION__?: boolean
  }
}

/** The application bootstrap owns this handle until its document is closed. */
export interface StartupAnimation {
  /** The renderer has mounted after every client plugin activated. */
  mounted(): void
  /** Reveal the existing startup failure report immediately. */
  fail(): void
  /** Release media, observers, listeners, timers, and the overlay. */
  dispose(): void
}

const HANDOFF_MS = 500
const STARTUP_TIMEOUT_MS = 30_000

/**
 * Play the packaged clip when the Host or Desktop profile explicitly permits it.
 * Application initialization continues independently; disabled documents create no media.
 * @param doc - Application document; its plugin publishes data-dsh-startup-state.
 * @param source - Packaged media URL, available before the Desktop Host starts.
 * @returns Presentation lifecycle; failures and explicit skipping never block boot.
 */
export function startStartupAnimation(doc: Document, source: string): StartupAnimation {
  const win = doc.defaultView
  if (win === null || win.__DSH_STARTUP_ANIMATION__ !== true || win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return { mounted() {}, fail() {}, dispose() {} }
  }
  const activeWindow = win
  const text = startupCopy[win.navigator.language.startsWith('zh') ? 'zh' : 'en']
  const app = doc.getElementById('root')
  const previousInert = app?.inert ?? false
  const overlay = doc.createElement('div')
  overlay.className = 'autoflow-startup'
  overlay.dataset.dshStartupAnimation = 'playing'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', text.title)

  const video = doc.createElement('video')
  video.muted = true
  video.autoplay = true
  video.playsInline = true
  video.preload = 'auto'
  video.setAttribute('aria-hidden', 'true')
  video.src = source
  const status = doc.createElement('div')
  status.className = 'autoflow-startup-status'
  status.setAttribute('role', 'status')
  status.textContent = text.loading
  const skip = doc.createElement('button')
  skip.className = 'autoflow-startup-skip'
  skip.type = 'button'
  skip.textContent = text.skip
  overlay.append(video, status, skip)
  doc.body.append(overlay)
  if (app !== null) app.inert = true

  let mounted = false
  let ended = false
  let closing = false
  let disposed = false
  let handoff: number | undefined
  const observer = new win.MutationObserver(() => { reconcile() })
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-dsh-startup-state'] })

  const restoreApplication = (): void => {
    if (app !== null) app.inert = previousInert
  }
  const releaseMedia = (): void => {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
  const detach = (): void => {
    observer.disconnect()
    win.clearTimeout(watchdog)
    doc.removeEventListener('keydown', onKey)
    win.removeEventListener('pagehide', dispose)
    video.removeEventListener('ended', onEnded)
    video.removeEventListener('error', dispose)
    skip.removeEventListener('click', finish)
  }
  function dispose(): void {
    if (disposed) return
    disposed = true
    closing = true
    detach()
    activeWindow.clearTimeout(handoff)
    releaseMedia()
    restoreApplication()
    overlay.remove()
  }
  function finish(): void {
    if (closing) return
    closing = true
    detach()
    video.pause()
    restoreApplication()
    overlay.dataset.dshStartupAnimation = 'leaving'
    overlay.removeAttribute('aria-modal')
    handoff = activeWindow.setTimeout(dispose, HANDOFF_MS)
  }
  function reconcile(): void {
    if (closing || !mounted) return
    const state = doc.documentElement.getAttribute('data-dsh-startup-state')
    if (state === null || state === 'error') { finish(); return }
    if (ended && state === 'ready') finish()
  }
  function onEnded(): void {
    ended = true
    overlay.dataset.dshStartupAnimation = 'waiting'
    reconcile()
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    finish()
  }

  video.addEventListener('ended', onEnded)
  video.addEventListener('error', dispose)
  skip.addEventListener('click', finish)
  doc.addEventListener('keydown', onKey)
  win.addEventListener('pagehide', dispose, { once: true })
  const watchdog = win.setTimeout(dispose, STARTUP_TIMEOUT_MS)
  skip.focus({ preventScroll: true })
  void video.play().catch(dispose)

  return {
    mounted() { mounted = true; reconcile() },
    fail: dispose,
    dispose,
  }
}
