import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime/src/translate.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { imageStatusFrame } from '../src/client/status-schedule.ts'
import { createImageProcessStatus, type ImageProcessStatusProps } from '../src/client/status.tsx'
import { zh } from '../src/client/locales.ts'
import type { ImageViewTask } from '../src/shared/image-view.ts'
import { readFile, writeFile } from 'node:fs/promises'

const Status = createImageProcessStatus(React, { FileTypeIcon: () => React.createElement('svg', { 'data-image-icon': true }) })
function markup(state: ImageViewTask['state'], closed = false, failedRead = false, query = false, queryError = false): string {
  const sessionId = brandString<ImageProcessStatusProps['sessionId']>('image-status-session')
  const value = { version: 1, sessionId, pollIntervalMs: 1000, tasks: [{ taskId: 'task-one', callId: 'generate', state, createdAt: 1000, updatedAt: 2000, deadlineAt: 301000, assets: [] }] }
  const props: ImageProcessStatusProps = {
    sessionId, closed, fallback: React.createElement('span', null, 'default process'), t: makeTranslate(zh), renderLeadingIcon: icon => icon,
    tool: queryError ? { kind: 'tool-result', seq: 10, callId: 'result-call', name: 'codex_image_result', time: 1000, callTime: 1000, subCalls: [],
      call: { name: 'codex_image_result', argsRaw: '{"taskId":"task-one"}' }, args: PartialArguments.fromText('{"taskId":"task-one"}'), content: [], isError: true }
      : { phase: 'start', callId: query ? 'result-call' : 'generate', name: query ? 'codex_image_result' : 'codex_image_generate', time: 1000, turn: 1, step: 1, subCalls: [],
        argsRaw: query ? '{"taskId":"task-one"}' : '{}', args: PartialArguments.fromText(query ? '{"taskId":"task-one"}' : '{}') },
    useResource: (() => ({ status: failedRead ? 'failed' : 'ready', value, failure: undefined })) as ImageProcessStatusProps['useResource'],
  }
  return renderToStaticMarkup(React.createElement(Status, props))
}

test('image status phrases change every 10–14 seconds without adjacent repeats or remount resets', () => {
  for (const task of ['task-one', 'task-two', '图像任务']) {
    let now = 1000
    let frame = imageStatusFrame(task, 1000, now)
    const seen = new Set<number>([frame.index])
    for (let i = 0; i < 24; i++) {
      assert.ok(frame.nextAt - frame.changedAt >= 10_000)
      assert.ok(frame.nextAt - frame.changedAt <= 14_000)
      assert.deepEqual(imageStatusFrame(task, 1000, frame.nextAt - 1), frame)
      now = frame.nextAt
      const next = imageStatusFrame(task, 1000, now)
      assert.notEqual(next.index, frame.index)
      assert.deepEqual(imageStatusFrame(task, 1000, now), next, 'reopening the same task keeps its current phrase')
      seen.add(next.index)
      frame = next
    }
    assert.equal(seen.size, 6)
  }
})

test('different tasks have varied phrase orders and a clock before task creation stays at its first phrase', () => {
  const signatures = new Set(Array.from({ length: 20 }, (_, n) => {
    const task = `image-${n}`
    const first = imageStatusFrame(task, 1000, 1000)
    return `${first.index}:${first.nextAt}`
  }))
  assert.ok(signatures.size > 10)
  assert.deepEqual(imageStatusFrame('one', 1000, 0), imageStatusFrame('one', 1000, 1000))
})

test('only active image tasks get a rotating phrase; terminal states and disconnected reads retain fixed labels', ctx => {
  ctx.mock.method(Date, 'now', () => 5000)
  assert.match(markup('sent'), /data-image-icon|ci-status-copy/)
  assert.match(markup('sent'), /正在生成图片/)
  assert.match(markup('sent', false, false, true), /ci-status-copy/, 'result queries keep the generating task and its phrase')
  assert.doesNotMatch(markup('succeeded'), /ci-status-copy/)
  assert.match(markup('succeeded', false, true), /图片已生成/)
  assert.match(markup('sent', false, true), /连接暂时中断/)
  assert.doesNotMatch(markup('sent', false, true), /ci-status-copy/)
  assert.doesNotMatch(markup('sent', true), /ci-status-copy/)
  assert.match(markup('failed'), /图片生成失败/)
  assert.match(markup('cancelled'), /已取消生成/)
  assert.match(markup('outcome-unknown'), /生成结果待确认/)
  const queryFailed = markup('sent', false, false, true, true)
  assert.match(queryFailed, /暂时无法读取任务状态/)
  assert.doesNotMatch(queryFailed, /图片生成失败|ci-status-copy/)
  assert.match(markup('succeeded', false, false, true, true), /图片已生成/, 'a failed query does not overwrite a confirmed completed task')
})

test('the combined process status matches its owner-local keyless presentation snapshot', async ctx => {
  ctx.mock.method(Date, 'now', () => 5000)
  const value = [markup('sent'), markup('succeeded'), markup('failed'), markup('outcome-unknown')].join('\n') + '\n'
  const file = new URL('./fixtures/image-process-status.expected.html', import.meta.url)
  if (process.env.DSH_UPDATE_IMAGE_SNAPSHOT === '1') await writeFile(file, value, 'utf8')
  assert.equal(await readFile(file, 'utf8'), value)
})
