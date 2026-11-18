/** Keyless markup snapshots cover card preparation, durable images and retained partial results. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DisclosureRowProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime/src/translate.ts'
import { createImageCard, type ImageToolRowProps, type ConversationImageProps } from '../src/client/card.tsx'
import { recordedImageTask } from '../src/client/model.ts'
import { zh } from '../src/client/locales.ts'

function DisclosureStub({ title, icon, expandable, open, collapsedContent, headerAccessory, children }: DisclosureRowProps) {
  return React.createElement('section', null,
    React.createElement('div', { role: expandable ? 'button' : undefined, 'aria-expanded': expandable ? open : undefined },
      icon, title, collapsedContent), headerAccessory, open && children)
}

const { ConversationCard: Card, ToolCard } = createImageCard(React, { Modal: () => null, IconCloseOutlineRegular: () => React.createElement('svg'),
  IconInspectOutlineRegular: () => React.createElement('svg', { 'data-inspect-icon': true }),
  DisclosureRow: React.memo<typeof DisclosureStub>(DisclosureStub),
  ImageGenerationSkeleton: ({ className }) => React.createElement('canvas', { className, 'aria-hidden': true }),
  FileTypeIcon: () => React.createElement('svg', { 'data-image-icon': true }) })
const common = {
  sessionId: brandString<ConversationImageProps['sessionId']>('card-session'), callId: 'generate-call', toolName: 'codex_image_generate', t: makeTranslate(zh),
  useResource: () => ({ status: 'none' as const, value: undefined, failure: undefined }),
  mediaUrl: (task: string, asset: string, variant: string) => `/api/codex-subscription/media?task=${task}&asset=${asset}&variant=${variant}`,
  inspectCall: () => {},
}
const call = { name: 'codex_image_generate', argsRaw: '{"prompt":"an image"}' }
const meta = { version: 1, taskId: 'image-task', state: 'succeeded', createdAt: 100, deadlineAt: 300100, includeImages: false,
  assets: [{ id: 'image-asset', mimeType: 'image/png', name: 'image.png', width: 128, height: 128 }], error: null }
function settled(state: string): Extract<ImageToolRowProps, { phase: 'result' }> {
  return { ...common, phase: 'result', block: { kind: 'tool-result', seq: 4, time: 200, callId: common.callId, callTime: 100, name: call.name,
    args: PartialArguments.fromText(call.argsRaw), call, content: [], isError: false, subCalls: [], meta: { codexImage: { ...meta, state } } } }
}
function markup(props: ImageToolRowProps, expanded = false, live = false): string {
  const node: ConversationImageProps['node'] = { key: 'image', id: common.callId, kind: 'codex-image', target: 'chat', anchorSeq: 1, location: { kind: 'unresolved' }, visibility: 'visible',
    data: { callId: common.callId, live, settled: props.phase === 'result', failed: props.phase === 'result' && props.block.isError,
      saved: props.phase === 'result' ? recordedImageTask(props.block.meta, props.block.content, props.block.time) : undefined } }
  return renderToStaticMarkup(React.createElement(Card, { ...common, node,
    useDisclosure: () => ({ expanded, toggle() {}, setExpanded() {} }) }))
}

test('one generation disclosure keeps previews collapsed until requested', () => {
  const collapsed = markup(settled('succeeded'))
  assert.match(collapsed, /aria-expanded="false"/)
  assert.match(collapsed, /图片已生成/)
  assert.match(collapsed, /1 张/)
  assert.match(collapsed, /aria-label="查看图片生成调用详情"/)
  assert.doesNotMatch(collapsed, /<img|<canvas|image-asset/)
  const complete = markup(settled('succeeded'), true)
  assert.match(complete, /aria-expanded="true"/)
  assert.match(complete, /alt="image.png"/)
  assert.doesNotMatch(complete, /100%|<pre/)
})

test('a dispatched request shows one loader when its disclosure is open', () => {
  const pending = markup({ ...common, phase: 'start', block: { phase: 'start', callId: common.callId, name: call.name,
    argsRaw: call.argsRaw, time: 100, turn: 1, step: 1, subCalls: [], args: PartialArguments.fromText(call.argsRaw) } }, true, true)
  assert.match(pending, /正在准备图片/)
  assert.match(pending, /aria-busy="true">\s*<canvas/)
})

test('unknown work retains its saved image and offers no regeneration action', () => {
  const html = markup(settled('outcome-unknown'), true)
  assert.match(html, /image-asset/)
  assert.match(html, /生成结果待确认/)
  assert.match(html, /部分图片已保存/)
  assert.doesNotMatch(html, /重新生成|resubmit/)
})

test('the raw generation row only names preparation before the disclosure exists', () => {
  const props: ImageToolRowProps = { ...common, phase: 'preparing', block: { phase: 'preparing', callId: common.callId,
    name: call.name, time: 100, turn: 1, step: 1, subCalls: [], args: PartialArguments.EMPTY } }
  const html = renderToStaticMarkup(React.createElement(ToolCard, props))
  assert.match(html, /图片生成请求/)
  assert.doesNotMatch(html, /<button|<img|<canvas/)
  assert.equal(renderToStaticMarkup(React.createElement(ToolCard, settled('succeeded'))), '')
})

test('result polling does not duplicate the generation row', () => {
  const props = { ...settled('succeeded'), toolName: 'codex_image_result' }
  assert.equal(renderToStaticMarkup(React.createElement(ToolCard, props)), '')
})

test('a failed result read remains visible without another image or generation timer', () => {
  const result = settled('failed')
  const html = renderToStaticMarkup(React.createElement(ToolCard, { ...result, toolName: 'codex_image_result', block: { ...result.block, isError: true } }))
  assert.match(html, /暂时无法读取任务状态/)
  assert.doesNotMatch(html, /<img|<canvas|ci-elapsed/)
})

test('reopening a historical pending snapshot shows loading without an estimated percentage or generation timer', () => {
  const html = markup(settled('sent'), true)
  assert.match(html, /<canvas/)
  assert.doesNotMatch(html, /progressbar|aria-valuenow|<small>预计| 秒|ci-elapsed/)
  assert.match(html, /正在加载图片/)
})

test('image card markup matches the owner-local keyless snapshot', async () => {
  const value = [markup(settled('succeeded')), markup(settled('succeeded'), true), markup(settled('outcome-unknown'), true)].join('\n') + '\n'
  const file = new URL('./fixtures/image-card.expected.html', import.meta.url)
  if (process.env['DSH_UPDATE_IMAGE_SNAPSHOT'] === '1') { await mkdir(new URL('./fixtures/', import.meta.url), { recursive: true }); await writeFile(file, value, 'utf8') }
  assert.equal(value, await readFile(file, 'utf8'))
})
