/** Session card projections keep private account data out of browser task resources. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageTask } from '../src/host/images/types.ts'
import { projectImageSession } from '../src/host/images/view.ts'
import { imageSessionViewSchema } from '../src/shared/image-view.ts'

function task(id: string, sessionId: string): ImageTask {
  return { id, owner: { kind: 'session', sessionId, toolCallId: `call-${id}` }, state: 'succeeded', prompt: 'private prompt',
    model: 'gpt-image-2', createdAt: 1, updatedAt: 2, deadlineAt: 3, accountKey: 'private-account',
    assets: [{ id: `asset-${id}`, mimeType: 'image/png', original: { attachmentId: AttachmentId('original'), bytes: 10, name: 'result.png' },
      preview: { attachmentId: AttachmentId('preview'), mediaType: 'image/png', bytes: 5, width: 128, height: 128 } }] }
}

test('session projections exclude other sessions and private account fields', () => {
  const result = imageSessionViewSchema.parse(projectImageSession('one', [task('a', 'one'), task('b', 'two')], 1000))
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0]?.taskId, 'a')
  assert.equal(result.tasks[0]?.callId, 'call-a')
  assert.equal(result.tasks[0]?.assets[0]?.name, 'result.png')
  assert.doesNotMatch(JSON.stringify(result), /private-account|private prompt|attachmentId/)
})

test('partial and unknown tasks keep their existing assets and safe failure codes', () => {
  const input = task('a', 'one')
  input.state = 'outcome-unknown'; input.error = { code: 'image-outcome-unknown', message: 'private backend message' }
  const result = projectImageSession('one', [input], 750)
  assert.equal(result.tasks[0]?.state, 'outcome-unknown')
  assert.equal(result.tasks[0]?.assets.length, 1)
  assert.equal(result.tasks[0]?.errorCode, 'image-outcome-unknown')
  assert.doesNotMatch(JSON.stringify(result), /private backend message/)
})
