/** Shared preview observation releases roots and ignores records from obsolete subscriptions. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createPreviewVisibility } from '../src/client/preview-visibility.ts'

type Entry = Pick<IntersectionObserverEntry, 'target' | 'isIntersecting' | 'time'>
function fixture() {
  const styles = new WeakMap<Element, string>()
  const observers: { root: Element | null; receive(entries: readonly Entry[]): void; elements: Set<Element>; observed: number; unobserved: number; disconnected: number }[] = []
  let clock = 0, styleReads = 0, createAttempts = 0, failCreate = false, failElement: Element | undefined
  const node = (parent: Element | null = null, overflow = 'visible') => {
    // Observation uses only ancestor links and object identity in this DOM-free fixture.
    const element = { parentElement: parent } as Element
    styles.set(element, overflow)
    return element
  }
  const visibility = createPreviewVisibility({ now: () => clock, overflowY(element) { styleReads++; return styles.get(element)! }, createObserver(receive, root) {
    createAttempts++
    if (failCreate) throw new Error('observer-create-failed')
    const instance = { root, receive, elements: new Set<Element>(), observed: 0, unobserved: 0, disconnected: 0 }
    observers.push(instance)
    return {
      observe(element) { instance.observed++; if (element === failElement) throw new Error('target-observe-failed'); instance.elements.add(element) },
      unobserve(element) { instance.unobserved++; instance.elements.delete(element) },
      disconnect() { instance.disconnected++; instance.elements.clear() },
    }
  } })
  return { node, visibility, observers, setClock(value: number) { clock = value }, failCreate(value: boolean) { failCreate = value }, failElement(value?: Element) { failElement = value }, counts: () => ({ styleReads, createAttempts }) }
}

test('1024 previews from different consumers share one nearest-scroll-root observer', () => {
  const f = fixture(), root = f.node(null, 'auto'), grid = f.node(root), releases: (() => void)[] = []
  const firstConsumer = (element: Element) => f.visibility.observe(element, () => {}), secondConsumer = (element: Element) => f.visibility.observe(element, () => {})
  for (let index = 0; index < 1024; index++) releases.push((index % 2 ? firstConsumer : secondConsumer)(f.node(f.node(grid))))
  assert.equal(f.observers.length, 1); assert.equal(f.observers[0]!.root, root)
  assert.equal(f.observers[0]!.observed, 1024); assert.equal(f.counts().styleReads, 3072)
  for (const release of releases.slice(0, -1)) release()
  assert.equal(f.observers[0]!.unobserved, 1023); assert.equal(f.observers[0]!.disconnected, 0)
  releases.at(-1)!()
  assert.equal(f.observers[0]!.disconnected, 1); assert.equal(f.observers[0]!.elements.size, 0)
})

test('different scroll roots and the viewport dispatch only their own target visibility', () => {
  const f = fixture(), outer = f.node(null, 'scroll'), inner = f.node(outer, 'auto')
  const first = f.node(inner), second = f.node(outer), third = f.node(), events: string[] = []
  const releases = [f.visibility.observe(first, visible => events.push(`inner:${visible}`)), f.visibility.observe(second, visible => events.push(`outer:${visible}`)), f.visibility.observe(third, visible => events.push(`viewport:${visible}`))]
  assert.deepEqual(f.observers.map(observer => observer.root), [inner, outer, null])
  f.observers[0]!.receive([{ target: first, time: 1, isIntersecting: true }, { target: second, time: 1, isIntersecting: true }])
  f.observers[1]!.receive([{ target: second, time: 1, isIntersecting: false }])
  f.observers[2]!.receive([{ target: third, time: 1, isIntersecting: true }])
  f.observers[0]!.receive([{ target: first, time: 2, isIntersecting: false }])
  assert.deepEqual(events, ['inner:true', 'outer:false', 'viewport:true', 'inner:false'])
  releases.forEach(release => release())
  assert.ok(f.observers.every(observer => observer.disconnected === 1))
})

test('multiple subscriptions to one target share observation and keep receiving visibility changes', () => {
  const f = fixture(), target = f.node(f.node(null, 'auto')), first: boolean[] = [], second: boolean[] = []
  const releaseFirst = f.visibility.observe(target, value => first.push(value))
  f.setClock(10)
  const releaseSecond = f.visibility.observe(target, value => second.push(value))
  f.observers[0]!.receive([{ target, time: 5, isIntersecting: true }])
  assert.deepEqual(first, [true]); assert.deepEqual(second, [true])
  const third: boolean[] = [], releaseThird = f.visibility.observe(target, value => third.push(value))
  assert.deepEqual(third, [true]); assert.equal(f.observers[0]!.observed, 1)
  releaseFirst(); releaseSecond()
  assert.equal(f.observers[0]!.unobserved, 0); assert.equal(f.observers[0]!.disconnected, 0)
  f.observers[0]!.receive([{ target, time: 20, isIntersecting: false }])
  assert.deepEqual(first, [true]); assert.deepEqual(second, [true]); assert.deepEqual(third, [true, false])
  releaseThird(); releaseThird()
  assert.equal(f.observers[0]!.disconnected, 1)
})

test('late records cannot revive a removed target or a replacement subscription to the same element', () => {
  const f = fixture(), root = f.node(null, 'auto'), target = f.node(root), keepAlive = f.node(root), events: string[] = []
  const old = f.visibility.observe(target, value => events.push(`old:${value}`)), keep = f.visibility.observe(keepAlive, () => {})
  old(); f.setClock(20)
  const replacement = f.visibility.observe(target, value => events.push(`replacement:${value}`))
  f.observers[0]!.receive([{ target, time: 10, isIntersecting: true }])
  assert.equal(events.length, 0)
  f.observers[0]!.receive([{ target, time: 21, isIntersecting: true }])
  assert.deepEqual(events, ['replacement:true'])
  replacement(); keep(); f.setClock(30)
  const latest = f.visibility.observe(target, value => events.push(`latest:${value}`))
  old(); replacement(); keep()
  assert.equal(f.observers.length, 2); assert.equal(f.observers[1]!.disconnected, 0)
  f.observers[0]!.receive([{ target, time: 40, isIntersecting: true }])
  f.observers[1]!.receive([{ target, time: 31, isIntersecting: false }])
  assert.deepEqual(events, ['replacement:true', 'latest:false'])
  latest(); assert.equal(f.observers[1]!.disconnected, 1)
})

test('failed native observation releases its registration without disturbing another target', () => {
  const f = fixture(), root = f.node(null, 'auto'), saved = f.node(root), failing = f.node(root), events: boolean[] = []
  const close = f.visibility.observe(saved, value => events.push(value))
  f.failElement(failing)
  assert.throws(() => f.visibility.observe(failing, () => { throw new Error('released-callback') }), /target-observe-failed/)
  assert.equal(f.observers[0]!.disconnected, 0)
  f.observers[0]!.receive([{ target: failing, time: 1, isIntersecting: true }, { target: saved, time: 1, isIntersecting: true }])
  assert.deepEqual(events, [true])
  assert.throws(() => f.visibility.observe(saved, () => { throw new Error('callback-replay-failed') }), /callback-replay-failed/)
  f.observers[0]!.receive([{ target: saved, time: 2, isIntersecting: false }]); assert.deepEqual(events, [true, false])
  close(); assert.equal(f.observers[0]!.disconnected, 1)
  f.failElement(); const retry = f.visibility.observe(failing, () => {})
  assert.equal(f.observers.length, 2); retry(); assert.equal(f.observers[1]!.disconnected, 1)
})

test('observer construction failures and single-target failures retain no reusable root', () => {
  const f = fixture(), root = f.node(null, 'auto'), target = f.node(root)
  f.failCreate(true)
  assert.throws(() => f.visibility.observe(target, () => {}), /observer-create-failed/)
  f.failCreate(false); f.failElement(target)
  assert.throws(() => f.visibility.observe(target, () => {}), /target-observe-failed/)
  assert.equal(f.observers[0]!.disconnected, 1)
  f.failElement(); const release = f.visibility.observe(target, () => {})
  assert.equal(f.counts().createAttempts, 3); assert.equal(f.observers.length, 2)
  release(); assert.equal(f.observers[1]!.disconnected, 1)
})
