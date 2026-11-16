/**
 * Vitest global setup.
 *
 * Node ≥ 22 defines a `localStorage` accessor on globalThis that resolves to
 * `undefined` unless the process was started with `--localstorage-file`
 * ("localStorage is not available because --localstorage-file was not
 * provided"). Because that key already exists, the jsdom environment's
 * global population never installs the document's own store, so a test
 * calling the bare global `localStorage` throws "Cannot read properties of
 * undefined" even though jsdom has a working one.
 *
 * Bridge the two: point the global at the jsdom window's Storage. The jsdom
 * environment exposes its instance as `globalThis.jsdom`; node-only suites
 * (no jsdom global) keep Node's accessor untouched.
 */
import { afterAll } from 'vitest'

const jsdomWindow = (globalThis as { jsdom?: { window?: Window } }).jsdom?.window
const storage = jsdomWindow?.localStorage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
if (storage !== undefined) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}

// jsdom has no layout notifications; resize-sensitive specs install recording observers.
if (storage !== undefined && typeof globalThis.ResizeObserver === 'undefined') {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class {
      observe = () => undefined
      unobserve = () => undefined
      disconnect = () => undefined
    },
  })
  afterAll(() => {
    if (descriptor !== undefined) {
      Object.defineProperty(globalThis, 'ResizeObserver', descriptor)
      return
    }
    Reflect.deleteProperty(globalThis, 'ResizeObserver')
  })
}
