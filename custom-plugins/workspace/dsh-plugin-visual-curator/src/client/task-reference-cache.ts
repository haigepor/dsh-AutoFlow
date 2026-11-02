/** The open picker owns these bounded pages; selections live independently of cache eviction. */
import type { TaskReferencePage } from '../shared/task-references.ts'

/** Deployment limits shared with the workbench's read-only batch cache. */
export interface TaskReferenceCachePolicy { ttlMs: number; maxViews: number; resourceTtlMs: number }
/** Loaded pages retain their original resource deadline and independent scroll position. */
export interface TaskReferenceView { page: TaskReferencePage; expiresAt: number; scrollTop: number }

/** @param policy Memory and expiry limits; zero disables reuse between views. @param now Clock for cache expiry. @returns Picker-local LRU pages without persisted authorization URLs. */
export function createTaskReferenceCache(policy: TaskReferenceCachePolicy, now: () => number = Date.now) {
  const views = new Map<string, TaskReferenceView>()
  const prune = () => {
    if (!policy.ttlMs || !policy.maxViews || !policy.resourceTtlMs) { views.clear(); return }
    for (const [key, view] of views) if (view.expiresAt <= now()) views.delete(key)
    while (views.size > policy.maxViews) views.delete(views.keys().next().value!)
  }
  return {
    get(key: string): TaskReferenceView | undefined {
      prune(); const view = views.get(key)
      if (view) { views.delete(key); views.set(key, view) }
      return view
    },
    remember(key: string, page: TaskReferencePage, readAt: number, previous?: TaskReferenceView): TaskReferenceView {
      // 追加尾页不能延长首页资源授权或缓存的原始期限。
      const expiresAt = Math.min(readAt + (policy.ttlMs || Infinity), readAt + (policy.resourceTtlMs || Infinity), page.resourceExpiresAt ?? Infinity, previous?.expiresAt ?? Infinity)
      const view = { page, expiresAt, scrollTop: previous?.scrollTop ?? 0 }
      views.delete(key); views.set(key, view); prune()
      return view
    },
  }
}
