/** Durable task identity, partial galleries and capped estimates survive replay. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { imageEstimate, recordedImageTask, selectImageTask, sessionGallery } from '../src/client/model.ts'
import { loadingRegions } from '../src/client/motion.ts'
import type { ImageSessionView, ImageViewTask } from '../src/shared/image-view.ts'

const task: ImageViewTask = { taskId: 'one', callId: 'call-one', state: 'sent', createdAt: 100, updatedAt: 200, deadlineAt: 300100, assets: [] }
const value = { version: 1, taskId: 'one', state: 'succeeded', createdAt: 100, deadlineAt: 300100,
  assets: [{ id: 'asset-one', name: 'one.png', mimeType: 'image/png', width: 128, height: 128 }], error: null }
const view = (tasks: ImageViewTask[]): ImageSessionView => ({ version: 1, sessionId: 'session', pollIntervalMs: 1000, tasks })

test('recognized metadata and canonical nested results restore images without reading account fields', () => {
  const meta = recordedImageTask({ codexImage: value, private: 'not displayed' }, [], 400)
  assert.equal(meta?.assets[0]?.assetId, 'asset-one')
  assert.equal(meta?.updatedAt, 400)
  assert.deepEqual(recordedImageTask(undefined, [{ type: 'text', text: JSON.stringify(value) }], 400), meta)
  assert.equal(recordedImageTask({ codexImage: { ...value, version: 2 } }, [], 400), undefined)
  assert.equal(recordedImageTask(null, [{ type: 'text', text: 'not JSON' }], 400), undefined)
})

test('recorded completion is not replaced by an older pending resource frame', () => {
  const saved = recordedImageTask({ codexImage: value }, [], 400)
  assert.equal(selectImageTask(view([task]), 'call-one', undefined, saved)?.state, 'succeeded')
  assert.equal(selectImageTask(view([task]), 'call-one', undefined, saved)?.callId, 'call-one')
  const final = { ...task, state: 'succeeded' as const, updatedAt: 500 }
  assert.equal(selectImageTask(view([final]), 'result-call', 'one', saved), final)
  const delayedPending = { ...task, updatedAt: 900 }
  assert.equal(selectImageTask(view([final]), 'call-one', undefined, delayedPending), final,
    'a later tool-log timestamp must not turn an authoritative completed task back into pending work')
  assert.equal(selectImageTask(view([task]), 'different-call', 'other', undefined), undefined)
})

test('partial assets stay in one stable chronological session gallery across result polls', () => {
  const saved = recordedImageTask({ codexImage: value }, [], 400)
  assert.ok(saved)
  const partial = { ...saved, taskId: 'two', state: 'outcome-unknown' as const, createdAt: 500 }
  const images = sessionGallery(view([partial, saved]), saved)
  assert.deepEqual(images.map(image => image.key), ['one:asset-one', 'two:asset-one'])
  assert.equal(sessionGallery(undefined, saved).length, 1)
})

test('elapsed time alone never completes a running task', () => {
  assert.ok(imageEstimate(task, 10000000) <= 90)
  assert.equal(imageEstimate({ ...task, state: 'queued' }, 10000000), 0)
  assert.equal(imageEstimate({ ...task, state: 'succeeded' }, 100), 100)
  assert.equal(imageEstimate({ ...task, state: 'failed' }, 10000000), 0)
})

test('steady regions retain their radius while moving or holding a split', () => {
  for (const [start, end] of [[0, 2], [4, 6], [8, 10]] as const) {
    const radius = loadingRegions(start)[0]?.radius
    for (let time = start; time < end; time += .1) for (const field of loadingRegions(time)) assert.equal(field.radius, radius)
  }
})
