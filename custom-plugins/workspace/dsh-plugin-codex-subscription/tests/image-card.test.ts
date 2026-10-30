/** Keyless markup snapshots cover card preparation, durable images and retained partial results. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime/src/translate.ts'
import { createImageCard, type ImageCardProps, type ConversationImageProps } from '../src/client/card.tsx'
import { recordedImageTask } from '../src/client/model.ts'
import { zh } from '../src/client/locales.ts'

const { ConversationCard: Card, ToolCard } = createImageCard(React, { Modal: () => null, IconCloseOutlineRegular: () => null,
  FileTypeIcon: () => React.createElement('svg', { 'data-image-icon': true }) })
const common = {
  sessionId: brandString<ImageCardProps['sessionId']>('card-session'), callId: 'generate-call', toolName: 'codex_image_generate', t: makeTranslate(zh),
  useResource: () => ({ status: 'none' as const, value: undefined, failure: undefined }),
  mediaUrl: (task: string, asset: string, variant: string) => `/api/codex-subscription/media?task=${task}&asset=${asset}&variant=${variant}`,
}
const call = { name: 'codex_image_generate', argsRaw: '{"prompt":"an image"}' }
const meta = { version: 1, taskId: 'image-task', state: 'succeeded', createdAt: 100, deadlineAt: 300100, includeImages: false,
  assets: [{ id: 'image-asset', mimeType: 'image/png', name: 'image.png', width: 128, height: 128 }], error: null }
function settled(state: string): ImageCardProps {
  return { ...common, phase: 'result', block: { kind: 'tool-result', seq: 4, time: 200, callId: common.callId, callTime: 100, name: call.name,
    args: PartialArguments.fromText(call.argsRaw), call, content: [], isError: false, subCalls: [], meta: { codexImage: { ...meta, state } } } }
}
function markup(props: ImageCardProps, live = false): string {
  const node: ConversationImageProps['node'] = { key: 'image', id: common.callId, kind: 'codex-image', target: 'chat', anchorSeq: 1, location: { kind: 'unresolved' }, visibility: 'visible', groupTree: 'turn',
    data: { callId: common.callId, live, settled: props.phase === 'result', failed: props.phase === 'result' && props.block.isError,
      saved: props.phase === 'result' ? recordedImageTask(props.block.meta, props.block.content, props.block.time) : undefined } }
  return renderToStaticMarkup(React.createElement(Card, { ...common, node }))
}

test('preparing shows one image loader and successful text-only routes still show their saved images', () => {
  const preparing = markup({ ...common, phase: 'preparing', block: { phase: 'preparing', callId: common.callId, name: call.name, time: 100, turn: 1, step: 1,
    subCalls: [], args: PartialArguments.EMPTY } })
  assert.match(preparing, /aria-busy="true"/)
  assert.match(preparing, /正在准备图片/)
  const complete = markup(settled('succeeded'))
  assert.match(complete, /image-asset/)
  assert.match(complete, /alt="image.png"/)
  assert.doesNotMatch(complete, /100%|<pre/)
})

test('unknown work retains its saved image and offers no regeneration action', () => {
  const html = markup(settled('outcome-unknown'))
  assert.match(html, /image-asset/)
  assert.match(html, /生成结果待确认/)
  assert.match(html, /部分图片已保存/)
  assert.doesNotMatch(html, /重新生成|resubmit/)
})

test('generation history shows one image icon row without another gallery action', () => {
  const html = renderToStaticMarkup(React.createElement(ToolCard, settled('succeeded')))
  assert.match(html, /data-image-icon/)
  assert.match(html, /图片生成请求/)
  assert.doesNotMatch(html, /图片已生成|正在生成图片|role="status"/)
  assert.doesNotMatch(html, /查看图片/)
  assert.doesNotMatch(html, /<img|<canvas/)
})

test('image request details do not subscribe to task status or repeat the process summary', () => {
  let reads = 0
  const props = { ...settled('sent'), inspect: () => {}, useResource: () => { reads++; return common.useResource() } }
  const html = renderToStaticMarkup(React.createElement(ToolCard, props))
  assert.match(html, /<button[^>]+aria-label="查看图片生成调用详情"/)
  assert.match(html, /图片生成请求/)
  assert.doesNotMatch(html, /正在生成图片|图片已生成|progressbar|ci-status-copy/)
  assert.equal(reads, 0)
})

test('result polling does not duplicate the generation row', () => {
  const props = { ...settled('succeeded'), toolName: 'codex_image_result' }
  assert.equal(renderToStaticMarkup(React.createElement(ToolCard, props)), '')
})

test('a failed result read remains visible without another image or generation timer', () => {
  const result = settled('failed')
  assert.equal(result.phase, 'result')
  if (result.phase !== 'result') return
  const html = renderToStaticMarkup(React.createElement(ToolCard, { ...result, toolName: 'codex_image_result', block: { ...result.block, isError: true } }))
  assert.match(html, /暂时无法读取任务状态/)
  assert.doesNotMatch(html, /<img|<canvas|ci-elapsed/)
})

test('reopening a historical pending snapshot shows loading without an estimated percentage or generation timer', () => {
  const html = markup(settled('sent'))
  assert.match(html, /<canvas/)
  assert.doesNotMatch(html, /progressbar|aria-valuenow|<small>预计| 秒|ci-elapsed/)
  assert.match(html, /正在加载图片/)
})

test('image card markup matches the owner-local keyless snapshot', async () => {
  const value = [markup(settled('succeeded')), markup(settled('outcome-unknown')),
    renderToStaticMarkup(React.createElement(ToolCard, settled('succeeded')))].join('\n') + '\n'
  const file = new URL('./fixtures/image-card.expected.html', import.meta.url)
  if (process.env['DSH_UPDATE_IMAGE_SNAPSHOT'] === '1') { await mkdir(new URL('./fixtures/', import.meta.url), { recursive: true }); await writeFile(file, value, 'utf8') }
  assert.equal(value, await readFile(file, 'utf8'))
})
