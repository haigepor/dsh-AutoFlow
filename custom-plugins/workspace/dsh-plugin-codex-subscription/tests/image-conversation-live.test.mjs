import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembler.ts'
import { assistantDefinition } from '../../../../packages/client/ui-chat/src/client/conversation-nodes/assistant.ts'
import { toolDefinition } from '../../../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts'
import { turnProcessDefinition } from '../../../../packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts'
import { chatViewDefinition } from '../../../../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { processGroupDefinition } from '../../../../packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts'
import { imageConversationDefinition, imageTurnDefinition } from '../src/client/conversation.ts'

function conversation() {
  const definitions = [assistantDefinition, toolDefinition, turnProcessDefinition, imageTurnDefinition, imageConversationDefinition]
  const assembler = new ConversationNodeAssembler(
    { entries: () => definitions, fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
    { forTarget: target => target === 'chat' ? processGroupDefinition : undefined },
  )
  assembler.replaceWindow([], false)
  assembler.activateTarget('chat')
  let seq = 0
  return {
    assembler,
    append(type, data, extra = {}) {
      assembler.append({ type: 'event', event: { seq: ++seq, time: 1_700_000_000_000 + seq, type, data, ...extra } })
      assembler.flush()
    },
    nodes: () => assembler.snapshot('chat').nodes.values(),
    groups: () => {
      const grouped = assembler.grouped('chat')
      return grouped.entries.filter(entry => entry.kind === 'group').map(entry => grouped.groupSource(entry.key).getSnapshot())
    },
  }
}

test('live generation joins its process group and stays at dispatch through subsequent tools and reasoning', () => {
  const view = conversation()
  view.append('turn/start', { turn: 1 })
  view.append('step/start', { turn: 1, step: 1 })
  view.append('assistant/live-chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'Prepare an image prompt.' } })
  assert.equal(view.nodes().filter(node => node.kind === 'codex-image').length, 0)
  assert.equal(view.groups()[0].data.closed, false)
  assert.equal(view.groups()[0].data.summary.runningDetail, 'Prepare an image prompt.')
  view.append('tool/call', { turn: 1, step: 1, callId: 'skill', name: 'skill', arguments: '{"name":"imagegen"}' })
  assert.equal(view.nodes().filter(node => node.kind === 'codex-image').length, 0)
  assert.equal(view.groups()[0].data.summary.running, 'tools')
  view.append('tool/result', { turn: 1, step: 1, message: { id: 'skill-result', role: 'tool', toolCallId: 'skill',
    source: { kind: 'tool', callId: 'skill' }, content: [{ type: 'text', text: 'Skill ready.' }] } }, { surfaceOp: 'append' })
  view.append('step/end', { turn: 1, step: 1 })
  view.append('step/start', { turn: 1, step: 2 })
  view.append('assistant/live-chunk', { turn: 1, step: 2, chunk: { type: 'tool-call-delta', index: 0,
    id: 'generate', name: 'codex_image_generate', argumentsDelta: '{"prompt":"A green square"}' } })
  assert.equal(view.nodes().filter(node => node.kind === 'codex-image').length, 0, 'argument streaming is preparation, not dispatch')
  view.append('tool/call', { turn: 1, step: 2, callId: 'generate', name: 'codex_image_generate', arguments: '{"prompt":"A green square"}' })
  assert.equal(view.nodes().filter(node => node.kind === 'codex-image').length, 1)
  assert.equal(view.groups().length, 1)
  assert.equal(view.groups()[0].data.closed, false)
  assert.equal(view.groups()[0].data.summary.running, 'tools')
  const image = view.nodes().find(node => node.kind === 'codex-image')
  assert.equal(image.data.live, true)
  assert.ok(view.groups()[0].members.some(member => member.key === image.key))
  view.append('tool/call', { turn: 1, step: 2, callId: 'query', name: 'codex_image_result', arguments: '{"taskId":"one"}' })
  assert.equal(view.nodes().filter(node => node.kind === 'codex-image').length, 1, 'query calls must not duplicate the card')
  assert.equal(view.groups().length, 1, 'an image never splits the process group')
  assert.equal(view.groups()[0].data.closed, false)
  view.append('step/end', { turn: 1, step: 2 })
  view.append('step/start', { turn: 1, step: 3 })
  view.append('assistant/live-chunk', { turn: 1, step: 3, chunk: { type: 'reasoning-delta', index: 0, text: 'Checking the saved image.' } })
  assert.equal(view.groups().length, 1)
  const currentImage = view.nodes().find(node => node.kind === 'codex-image')
  const members = view.groups()[0].members.map(member => member.key)
  const query = view.nodes().find(node => node.kind === 'tool-call' && node.id === 'query')
  assert.equal(currentImage.anchorSeq, image.anchorSeq)
  assert.ok(members.includes(query.key) && members.indexOf(image.key) < members.indexOf(query.key))
  view.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(view.groups()[0].data.closed, true)
  assert.equal(view.nodes().find(node => node.kind === 'codex-image').data.live, false)
})

test('a direct image call does not invent preceding reasoning', () => {
  const view = conversation()
  view.append('turn/start', { turn: 1 })
  view.append('step/start', { turn: 1, step: 1 })
  view.append('tool/call', { turn: 1, step: 1, callId: 'generate', name: 'codex_image_generate', arguments: '{"prompt":"A green square"}' })
  assert.equal(view.nodes().filter(node => node.kind === 'codex-image').length, 1)
  assert.equal(view.nodes().filter(node => node.kind === 'assistant-step').length, 0)
  assert.equal(view.groups()[0].data.closed, false)
})

test('each dispatch keeps its own disclosure and the reply remains outside the process group', () => {
  const view = conversation()
  view.append('turn/start', { turn: 1 })
  view.append('step/start', { turn: 1, step: 1 })
  for (const callId of ['first', 'second']) {
    view.append('tool/call', { turn: 1, step: 1, callId, name: 'codex_image_generate', arguments: '{"prompt":"A green square"}' })
  }
  view.append('step/end', { turn: 1, step: 1 })
  view.append('step/start', { turn: 1, step: 2 })
  view.append('assistant/live-chunk', { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'Here are the saved files.' } })
  const images = view.nodes().filter(node => node.kind === 'codex-image')
  assert.deepEqual(images.map(image => image.data.callId), ['first', 'second'])
  const imageKeys = new Set(images.map(image => image.key))
  assert.deepEqual(view.groups()[0].members.filter(member => imageKeys.has(member.key)).map(member => member.key), [...imageKeys])
  assert.ok(view.assembler.grouped('chat').entries.some(entry => entry.kind === 'node' && entry.groupPart === 'response'))
})
