/** Previews in one scrolling element share a continuously active viewport observer. */
type VisibilityEntry = Pick<IntersectionObserverEntry, 'target' | 'isIntersecting' | 'time'>
type VisibilityObserver = Pick<IntersectionObserver, 'observe' | 'unobserve' | 'disconnect'>
interface Subscription { receive(visible: boolean): void }
interface Target { subscriptions: Set<Subscription>; since: number; visible?: boolean }
interface Root { observer: VisibilityObserver; targets: Map<Element, Target> }

/** @param dependencies Native observation, style reads and monotonic clock, replaceable in isolated tests. @returns Shared nearest-scroll-root observation; the final target releases its root and native observer. */
export function createPreviewVisibility(dependencies: {
  createObserver?: (receive: (entries: readonly VisibilityEntry[]) => void, root: Element | null) => VisibilityObserver
  overflowY?: (element: Element) => string
  now?: () => number
} = {}) {
  const roots = new Map<Element | null, Root>()
  const create = dependencies.createObserver ?? ((receive, root) => new IntersectionObserver(receive, { root }))
  const overflowY = dependencies.overflowY ?? (element => getComputedStyle(element).overflowY), now = dependencies.now ?? (() => performance.now())
  return {
    observe(element: Element, receive: (visible: boolean) => void): () => void {
      let root = element.parentElement
      while (root && !/(auto|scroll)/.test(overflowY(root))) root = root.parentElement
      let group = roots.get(root)
      if (!group) {
        const targets = new Map<Element, Target>()
        const observer = create(entries => {
          for (const entry of entries) {
            const target = targets.get(entry.target)
            if (!target) continue
            // Reusing a mounted element must not revive an earlier subscription's queued record.
            if (entry.time < target.since) continue
            target.visible = entry.isIntersecting
            for (const subscription of [...target.subscriptions]) {
              if (!target.subscriptions.has(subscription)) continue
              subscription.receive(entry.isIntersecting)
            }
          }
        }, root)
        group = { observer, targets }; roots.set(root, group)
      }
      const target: Target = group.targets.get(element) ?? { subscriptions: new Set<Subscription>(), since: now() }
      const first = !target.subscriptions.size, subscription: Subscription = { receive }, active = group
      target.subscriptions.add(subscription); active.targets.set(element, target)
      let released = false
      const release = () => {
        if (released) return
        released = true; target.subscriptions.delete(subscription)
        if (target.subscriptions.size) return
        active.targets.delete(element)
        if (active.targets.size) active.observer.unobserve(element)
        else { roots.delete(root); active.observer.disconnect() }
      }
      try {
        if (first) active.observer.observe(element)
        else if (target.visible !== undefined) receive(target.visible)
      } catch (error) { release(); throw error }
      return release
    },
  }
}

/** Component factories share this module instance; roots exist only while targets are subscribed. */
export const sharedPreviewVisibility = createPreviewVisibility()
