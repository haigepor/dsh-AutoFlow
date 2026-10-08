import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationCandidateModel, conversationCandidatePhotoModel, conversationSummaryPhotoModel, createAfpConversationSummary, conversationCallHasSummary } from '../src/client/afp-conversation-photos.js'

const row = (name, items, extra = {}) => ({ root: { kind: 'tool-result', call: { name }, content: [{ type: 'text', text: JSON.stringify({ items }) }], ...extra } })
const selection = (items, basis = 'metadata') => ({ root: { kind: 'tool-result', call: { name: 'afp_photo_selection' }, content: [{ type: 'text', text: JSON.stringify({ items, selection: { basis, criteria: 'Cats' } }) }] } })
test('process candidates deduplicate persisted pages and details including nested reads, ignoring errors and unrelated tools', () => {
  const detail = { root: { kind: 'tool-result', call: { name: 'afp_photo_details' }, content: [{ type: 'text', text: JSON.stringify({ found: true, photo: { id: 'one', title: 'Cat' } }) }] } }
  const rows = [row('afp_photo_search_start', [{ id: 'one', title: 'Cat', previewPath: 'https://outside/?token=secret' }]),
    row('afp_photo_search', [{ id: 'one' }, { id: 'two' }]), detail, row('other', [{ id: 'unrelated' }]),
    row('afp_photo_search', [{ id: 'failed' }], { isError: true }),
    { root: { callId: 'ptc', subCalls: [row('afp_collection_items', [{ id: 'three' }]).root] } }]
  const model = conversationCandidateModel(rows)
  assert.deepEqual(model.photos.map(photo => photo.id), ['one', 'two', 'three'])
  assert.equal(model.photos[0].title, 'Cat')
  assert.doesNotMatch(JSON.stringify(model), /secret|outside|failed|unrelated/)
})
test('final gallery requires explicit selection and follows its order, replacement, empty clearing and screening basis', () => {
  const rows = [row('afp_photo_search_start', [{ id: 'one' }, { id: 'two' }, { id: 'three' }])]
  assert.equal(conversationSummaryPhotoModel(rows).photos.length, 0)
  rows.push(selection([{ id: 'three' }, { id: 'one' }, { id: 'three' }]))
  assert.deepEqual(conversationSummaryPhotoModel(rows).photos.map(photo => photo.id), ['three', 'one'])
  assert.equal(conversationSummaryPhotoModel(rows).basis, 'metadata')
  rows.push({ root: { subCalls: [selection([{ id: 'two' }], 'visual').root] } })
  assert.deepEqual(conversationSummaryPhotoModel(rows).photos.map(photo => photo.id), ['two'])
  assert.equal(conversationSummaryPhotoModel(rows).basis, 'visual')
  rows.push({ root: { ...selection([{ id: 'failed' }]).root, isError: true } })
  assert.deepEqual(conversationSummaryPhotoModel(rows).photos.map(photo => photo.id), ['two'])
  rows.push(selection([])); assert.equal(conversationSummaryPhotoModel(rows).photos.length, 0)
})
test('summary uses the owning turn source and appears only on closure with actual photos', () => {
  let selectedTurn, selectedKind, rows = [selection([{ id: 'one' }])]
  const source = { subscribe() {}, getSnapshot: () => rows }
  const React = { createElement: (type, props) => ({ type, props }), useSyncExternalStore: (_subscribe, get) => get(),
    useState: initial => [initial, () => {}], useEffect() {} }
  const Card = () => null, Summary = createAfpConversationSummary(React, Card)
  const props = { turn: { turn: 7, status: 'open' }, useChat: select => select({ nodes: { turnDataSource(turn, kind) { selectedTurn = turn; selectedKind = kind; return source } } }) }
  assert.equal(Summary(props), null)
  props.turn.status = 'closed'
  const card = Summary(props)
  assert.equal(selectedTurn, 7); assert.equal(selectedKind, 'tool-call')
  assert.equal(card.type, Card); assert.equal(card.props.summary, true)
  assert.equal(card.props.photoModel.photos.length, 1)
  rows = []; assert.equal(Summary(props), null)
  props.turn.status = 'unknown'; assert.equal(Summary(props), null)
})

test('promotion hides only the completed owner including nested calls, preserving other turns and failed-only reads', () => {
  const turn = { turn: 7, status: 'open' }
  const root = { callId: 'parent', subCalls: [{ ...row('afp_photo_search_start', [{ id: 'one' }]).root, callId: 'nested' }] }
  const node = { kind: 'tool-call', data: { root }, location: { kind: 'step', turn } }
  const final = selection([{ id: 'one' }])
  const snapshot = { nodes: { values: () => [node], turnDataSource: () => ({ getSnapshot: () => [node.data, final] }) } }
  assert.equal(conversationCallHasSummary(snapshot, 'nested'), false)
  turn.status = 'closed'
  assert.equal(conversationCallHasSummary(snapshot, 'nested'), true)
  assert.equal(conversationCallHasSummary(snapshot, 'other-turn'), false)
  final.root.isError = true
  assert.equal(conversationCallHasSummary(snapshot, 'nested'), false)
})
test('only the latest successful read shows merged candidates; failure does not displace that gallery', () => {
  const first = row('afp_photo_search_start', [{ id: 'one' }]), next = row('afp_photo_search', [{ id: 'one' }, { id: 'two' }])
  first.root.callId = 'first'; next.root.callId = 'next'
  const rows = [first, { root: { callId: 'parent', subCalls: [next.root] } }, row('afp_photo_search', [], { callId: 'failed', isError: true })]
  const snapshot = { nodes: { values: () => rows.map(data => ({ kind: 'tool-call', data, location: { kind: 'turn', turn: { turn: 1, status: 'open' } } })), turnDataSource: () => ({ getSnapshot: () => rows }) } }
  assert.equal(conversationCandidatePhotoModel(snapshot, 'first').latest, false)
  const latest = conversationCandidatePhotoModel(snapshot, 'next')
  assert.equal(latest.latest, true); assert.deepEqual(latest.model.photos.map(photo => photo.id), ['one', 'two'])
  assert.equal(conversationCandidatePhotoModel(snapshot, 'failed').latest, false)
  assert.equal(conversationCandidatePhotoModel(snapshot, 'unknown'), null)
})
