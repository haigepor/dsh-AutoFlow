/** Picker pages expire independently of user selection and never prolong old media grants. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskReferenceCache } from '../src/client/task-reference-cache.ts'
import { taskReferencePageSchema } from '../src/shared/task-references.ts'

const page = taskReferencePageSchema.parse({ styleId: 'style', runId: 'task-a', tasks: [], images: [], totalImages: 10, nextImagePageToken: 'next' })

test('returning to a task reuses its pages and scroll without extending their original expiry', () => {
  let now = 0
  const cache = createTaskReferenceCache({ ttlMs: 100, maxViews: 2, resourceTtlMs: 1000 }, () => now)
  const first = cache.remember('a', page, now); first.scrollTop = 430
  now = 50; cache.remember('b', { ...page, runId: taskReferencePageSchema.parse({ ...page, runId: 'task-b' }).runId }, now)
  assert.equal(cache.get('a'), first); assert.equal(cache.get('a')?.scrollTop, 430)
  const appended = cache.remember('a', { ...page, nextImagePageToken: 'last' }, now, first)
  assert.equal(appended.scrollTop, 430); assert.equal(appended.expiresAt, 100)
  now = 100; assert.equal(cache.get('a'), undefined); assert.ok(cache.get('b'))
})

test('cache respects LRU capacity, authorization deadlines and disabled reuse', () => {
  let now = 0
  const cache = createTaskReferenceCache({ ttlMs: 100, maxViews: 2, resourceTtlMs: 70 }, () => now)
  cache.remember('a', page, now); cache.remember('b', page, now); cache.get('a'); cache.remember('c', page, now)
  assert.equal(cache.get('b'), undefined); assert.ok(cache.get('a'))
  cache.remember('grant', { ...page, resourceExpiresAt: 30 }, now)
  now = 30; assert.equal(cache.get('grant'), undefined)
  now = 70; assert.equal(cache.get('c'), undefined)
  for (const policy of [{ ttlMs: 0, maxViews: 2, resourceTtlMs: 70 }, { ttlMs: 100, maxViews: 0, resourceTtlMs: 70 }, { ttlMs: 100, maxViews: 2, resourceTtlMs: 0 }]) {
    const disabled = createTaskReferenceCache(policy, () => now); disabled.remember('a', page, now); assert.equal(disabled.get('a'), undefined)
  }
})
