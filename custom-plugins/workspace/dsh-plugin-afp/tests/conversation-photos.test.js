import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { conversationPhotoModel, createAfpConversationPhotos, registerAfpConversationPhotos } from '../src/client/afp-conversation-photos.js'

const result = payload => ({ phase: 'result', block: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false } })
const photo = { id: 'p/1?&', title: 'Cat', provider: 'AFP', caption: 'A cat' }

test('safe Agent error codes select compact localized states without exposing error bodies', () => {
  for (const [code, message] of [['authentication-failed', 'agentPhotosAuthenticationFailed'],
    ['access-denied', 'agentPhotosAccessDenied'], ['api-schema-rejected', 'agentPhotosSchemaRejected'],
    ['query-rejected', 'agentPhotosQueryRejected']]) {
    for (const channel of ['content', 'error']) {
      const text = JSON.stringify({ code, message: 'password=secret https://signed.example/?token=secret' })
      const block = { isError: true, ...(channel === 'content' ? { content: [{ type: 'text', text: `Error: ${text}` }] }
        : { error: { code: 'failed', message: text } }) }
      const model = conversationPhotoModel({ phase: 'result', block })
      assert.equal(model.message, message)
      assert.doesNotMatch(JSON.stringify(model), /secret|signed\.example/)
    }
  }
})

test('persisted photo cards cover search, details, collection pages and legacy metadata without trusting media URLs', () => {
  for (const payload of [{ items: [photo], cursor: 'opaque' }, { found: true, photo }, { items: [photo], offset: 10, total: 20 }]) {
    const model = conversationPhotoModel(result(payload))
    assert.equal(model.state, 'ok'); assert.equal(model.photos.length, 1)
    assert.equal(model.photos[0].previewPath, 'api/afp/preview?photoId=p%2F1%3F%26')
    assert.equal(Object.hasOwn(model, 'cursor'), false)
  }
  const model = conversationPhotoModel(result({ items: [{ ...photo, previewPath: 'https://outside.test/?token=secret', token: 'secret' }, photo, { id: '\u0000' }] }))
  assert.equal(model.photos.length, 1)
  assert.doesNotMatch(JSON.stringify(model), /outside|secret|token/)
})

test('preparing, running, interrupted, rejected, empty, absent and malformed records settle without leaking output', () => {
  assert.equal(conversationPhotoModel({ phase: 'preparing', block: {} }).state, 'running')
  assert.equal(conversationPhotoModel({ phase: 'start', block: {} }).state, 'running')
  assert.equal(conversationPhotoModel({ phase: 'result', block: { error: { code: 'interrupted' }, isError: true } }).state, 'stopped')
  const rejected = conversationPhotoModel({ phase: 'result', block: { isError: true, content: [{ type: 'text', text: 'token=secret' }] } })
  assert.equal(rejected.message, 'agentPhotosFailed'); assert.doesNotMatch(JSON.stringify(rejected), /secret/)
  assert.equal(conversationPhotoModel(result({ found: false, photo: null })).message, 'agentPhotoNotFound')
  assert.equal(conversationPhotoModel(result({ items: [] })).message, 'noPhotos')
  for (const payload of [null, [], {}, { items: {} }, { found: true, photo: null }, { items: [{ id: ' ' }] }]) {
    assert.equal(conversationPhotoModel(result(payload)).message, 'agentPhotosInvalid')
  }
  assert.equal(conversationPhotoModel({ phase: 'result', block: { content: [{ type: 'text', text: '{unfinished' }] } }).message, 'agentPhotosInvalid')
})

function element(type, props, ...children) { return { type, props: { ...props, children } } }
function nodes(tree, match) {
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, match))
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...nodes(tree.props?.children, match)]
}

function cardHarness(props, UI) {
  let cursor = 0
  const values = [], effects = []
  const React = { createElement: element, Fragment: Symbol('Fragment'),
    useState(initial) {
      const index = cursor++
      if (!(index in values)) values[index] = initial
      return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value }]
    },
    useRef(initial) { const index = cursor++; return values[index] ??= { current: initial } },
    useEffect(fn, deps) {
      const index = cursor++, prior = effects[index]
      if (prior && prior.deps.every((value, i) => value === deps[i])) return
      prior?.cleanup?.(); effects[index] = { fn, deps, pending: true }
    },
  }
  const icons = Object.fromEntries(['IconSearchOutlineRegular', 'IconChevronLeftOutlineRegular', 'IconChevronRightOutlineRegular'].map(key => [key, Symbol(key)]))
  const Component = createAfpConversationPhotos(React, UI, icons, key => key, {})
  return { render() { cursor = 0; return Component(props) },
    flushEffects() { for (const effect of effects) if (effect?.pending) { effect.pending = false; effect.cleanup = effect.fn() } },
    unmount() { for (const effect of effects) effect?.cleanup?.() } }
}

test('summary disclosure removes its gallery and preview while collapsed, then restores browsing', t => {
  const originalDocument = globalThis.document
  globalThis.document = { baseURI: 'https://profile.test/' }
  t.after(() => { globalThis.document = originalDocument })
  const UI = Object.fromEntries(['DisclosureRow', 'Modal', 'Button', 'Tag', 'Tooltip'].map(key => [key, Symbol(key)]))
  const harness = cardHarness({ summary: true, photoModel: conversationPhotoModel(result({ items: [photo] })) }, UI)
  let tree = harness.render()
  assert.equal(nodes(tree, node => node.type === 'article').length, 1)
  nodes(tree, node => node.type?.name === 'ImagePreview')[0].props.open()
  assert.equal(nodes(harness.render(), node => node.type === UI.Modal)[0].props.open, true)
  nodes(tree, node => node.type === UI.DisclosureRow)[0].props.onToggle()
  tree = harness.render()
  assert.equal(nodes(tree, node => node.type === 'article').length, 0)
  assert.equal(nodes(tree, node => node.type === UI.Modal)[0].props.open, false)
  nodes(tree, node => node.type === UI.DisclosureRow)[0].props.onToggle()
  assert.equal(nodes(harness.render(), node => node.type === 'article').length, 1)
})

test('completed process records retain status and inspection but cannot reopen duplicate galleries', t => {
  const originalDocument = globalThis.document
  globalThis.document = { baseURI: 'https://profile.test/' }
  t.after(() => { globalThis.document = originalDocument })
  const UI = Object.fromEntries(['DisclosureRow', 'Modal', 'Button', 'Tag', 'Tooltip'].map(key => [key, Symbol(key)]))
  const root = { ...result({ items: [photo] }).block, kind: 'tool-result', callId: 'call', call: { name: 'afp_photo_search' } }
  const final = { root: { kind: 'tool-result', call: { name: 'afp_photo_selection' }, content: [{ type: 'text', text: JSON.stringify({ items: [photo], selection: { basis: 'metadata' } }) }] } }
  const data = { root }, snapshot = { nodes: { values: () => [{ kind: 'tool-call', data, location: { kind: 'turn', turn: { turn: 1, status: 'closed' } } }], turnDataSource: () => ({ getSnapshot: () => [data, final] }) } }
  let expanded = true
  const harness = cardHarness({ phase: 'result', block: root, callId: 'call', toolName: 'afp_photo_search', inspect() {},
    useChat: select => select(snapshot), useDisclosure: () => ({ expanded, toggle() { expanded = !expanded } }) }, UI)
  harness.render(); harness.flushEffects()
  const tree = harness.render()
  assert.equal(nodes(tree, node => node.type === 'article').length, 0)
  const header = nodes(tree, node => node.type === UI.DisclosureRow)[0]
  assert.equal(header.props.expandable, false); assert.equal(header.props.open, false)
  assert.equal(nodes(tree, node => node.type === UI.Button).length, 1)
})

test('failed reads keep a compact status and inspection action beside the disclosure without exposing raw output', () => {
  const UI = Object.fromEntries(['DisclosureRow', 'Modal', 'Button', 'Tag', 'Tooltip'].map(key => [key, Symbol(key)]))
  let inspected = 0
  const tree = cardHarness({ phase: 'result', toolName: 'afp_photo_search_start',
    block: { isError: true, error: { message: JSON.stringify({ code: 'query-rejected' }) } },
    inspect: () => { inspected++ }, useDisclosure: () => ({ expanded: false, toggle() {} }) }, UI).render()
  const header = nodes(tree, node => node.props?.className === 'afp-chat-header')[0]
  assert.equal(nodes(header, node => node.type === UI.Button).length, 1)
  assert.equal(nodes(tree, node => node.type === UI.Button).length, 1)
  const disclosure = nodes(header, node => node.type === UI.DisclosureRow)[0]
  assert.equal(nodes(disclosure, node => node.type === UI.Button).length, 0, 'Animated text retains presentation-only children')
  nodes(header, node => node.type === UI.Button)[0].props.onClick()
  assert.equal(inspected, 1)
  const alert = nodes(disclosure.props.collapsedContent, node => node.props?.role === 'alert')[0]
  assert.equal(alert.props.children[0], 'agentPhotosQueryRejected')
})

test('AFP status and inspection text use the same font tier as the shared disclosure title', () => {
  const css = readFileSync(new URL('../assets/workbench.css', import.meta.url), 'utf8')
  const shared = readFileSync(new URL('../../../../packages/client/ui-primitives/src/DisclosureRow.module.css', import.meta.url), 'utf8')
  const sharedFont = shared.match(/\.title\s*\{[^}]*font-size:\s*([^;]+);/)[1]
  for (const selector of ['.afp-chat-flow-content', '.afp-chat-summary', '.afp-chat-photos .afp-chat-inspect']) {
    const rule = css.slice(css.indexOf(`${selector} {`)).split('}')[0]
    assert.equal(rule.match(/font-size:\s*([^;]+);/)[1], sharedFont)
  }
})

test('conversation thumbnails open the shared modal and same-origin links while performing no workbench actions', t => {
  const originalDocument = globalThis.document
  globalThis.document = { baseURI: 'https://profile.test/mounted/' }
  t.after(() => { globalThis.document = originalDocument })
  let expanded = false, inspected = 0
  const UI = Object.fromEntries(['DisclosureRow', 'Modal', 'Button', 'Tag', 'Tooltip'].map(key => [key, Symbol(key)]))
  const props = { ...result({ found: true, photo }), toolName: 'afp_photo_details', inspect: () => { inspected++ },
    useDisclosure: () => ({ expanded, toggle: () => { expanded = !expanded } }) }
  const harness = cardHarness(props, UI), render = harness.render
  let tree = render()
  assert.equal(nodes(tree, node => node.type === 'article').length, 0, 'Process photos start collapsed')
  nodes(tree, node => node.type === UI.DisclosureRow)[0].props.onToggle(); tree = render()
  assert.equal(nodes(tree, node => node.type === 'article').length, 1)
  const link = nodes(tree, node => node.type === 'a')[0]
  assert.equal(link.props.href, 'https://profile.test/mounted/api/afp/preview?photoId=p%2F1%3F%26')
  assert.equal(link.props.rel, 'noopener noreferrer')
  nodes(tree, node => node.type === UI.Button)[0].props.onClick(); assert.equal(inspected, 1)
  nodes(tree, node => node.type?.name === 'ImagePreview')[0].props.open()
  tree = render()
  const modal = nodes(tree, node => node.type === UI.Modal)[0]
  assert.equal(modal.props.open, true)
  assert.equal(nodes(modal, node => node.type?.name === 'ImagePreview')[0].props.large, true)
  assert.equal(nodes(modal, node => node.type === 'details')[0].props.open, undefined, 'Long identifiers start collapsed')
  assert.equal(nodes(modal.props.footer, node => node.type === 'a').length, 1)
  modal.props.onClose(); assert.equal(nodes(render(), node => node.type === UI.Modal)[0].props.open, false)
  nodes(tree, node => node.type === UI.DisclosureRow)[0].props.onToggle()
  assert.equal(nodes(render(), node => node.type === UI.DisclosureRow)[0].props.open, false)
})

test('multi-photo strips scroll in both directions, update edge buttons on scroll/resize and dispose observers', t => {
  const originalDocument = globalThis.document, originalObserver = globalThis.ResizeObserver, originalMatch = globalThis.matchMedia
  globalThis.document = { baseURI: 'https://profile.test/' }
  let resized, disconnected = 0
  globalThis.ResizeObserver = class { constructor(callback) { resized = callback } observe() {} disconnect() { disconnected++ } }
  globalThis.matchMedia = () => ({ matches: true })
  t.after(() => { globalThis.document = originalDocument; globalThis.ResizeObserver = originalObserver; globalThis.matchMedia = originalMatch })
  const UI = Object.fromEntries(['DisclosureRow', 'Modal', 'Button', 'Tag', 'Tooltip'].map(key => [key, Symbol(key)]))
  const props = { ...result({ items: ['one', 'two', 'three'].map(id => ({ ...photo, id })) }), toolName: 'afp_photo_search', useDisclosure: () => ({ expanded: true, toggle() {} }) }
  const harness = cardHarness(props, UI), moves = []
  const track = { scrollLeft: 0, scrollWidth: 696, clientWidth: 360, children: [2, 234, 466].map(offsetLeft => ({ offsetLeft })),
    scrollTo(options) { this.scrollLeft = Math.max(0, Math.min(options.left, this.scrollWidth - this.clientWidth)); moves.push(options) } }
  const stripOf = tree => nodes(tree, node => node.props?.className === 'afp-chat-photo-strip')[0]
  const button = (tree, label) => nodes(tree, node => node.type === UI.Button && node.props['aria-label'] === label)[0]
  let tree = harness.render()
  stripOf(tree).props.ref.current = track; harness.flushEffects(); tree = harness.render()
  assert.equal(stripOf(tree).props.tabIndex, 0)
  assert.equal(button(tree, 'agentPreviousPhotos').props.disabled, true)
  assert.equal(button(tree, 'agentNextPhotos').props.disabled, false)
  button(tree, 'agentNextPhotos').props.onClick(); stripOf(tree).props.onScroll(); tree = harness.render()
  assert.equal(track.scrollLeft, 232); assert.equal(button(tree, 'agentPreviousPhotos').props.disabled, false)
  assert.equal(moves[0].behavior, 'auto', 'Reduced motion disables smooth scrolling')
  button(tree, 'agentNextPhotos').props.onClick(); stripOf(tree).props.onScroll(); tree = harness.render()
  assert.equal(button(tree, 'agentNextPhotos').props.disabled, true)
  button(tree, 'agentPreviousPhotos').props.onClick(); stripOf(tree).props.onScroll(); tree = harness.render()
  assert.equal(track.scrollLeft, 232)
  track.clientWidth = 696; track.scrollLeft = 0; resized(); tree = harness.render()
  assert.equal(button(tree, 'agentNextPhotos'), undefined, 'Fitting galleries do not show inactive navigation')
  assert.equal(button(tree, 'agentPreviousPhotos'), undefined)
  assert.equal(nodes(tree, node => node.props?.className === 'afp-chat-strip-toolbar').length, 0)
  harness.unmount(); assert.equal(disconnected, 1)
})

test('enlarged multi-photo previews navigate by button and arrow key without wrapping or changing membership', t => {
  const originalDocument = globalThis.document
  globalThis.document = { baseURI: 'https://profile.test/' }
  t.after(() => { globalThis.document = originalDocument })
  const UI = Object.fromEntries(['DisclosureRow', 'Modal', 'Button', 'Tag', 'Tooltip'].map(key => [key, Symbol(key)]))
  const props = { ...result({ items: ['one', 'two', 'three'].map(id => ({ ...photo, id })) }), toolName: 'afp_collection_items', useDisclosure: () => ({ expanded: true, toggle() {} }) }
  const harness = cardHarness(props, UI)
  const modalOf = tree => nodes(tree, node => node.type === UI.Modal)[0]
  const button = (tree, label) => nodes(tree, node => node.type === UI.Button && node.props['aria-label'] === label)[0]
  nodes(harness.render(), node => node.type?.name === 'ImagePreview')[1].props.open()
  let modal = modalOf(harness.render())
  assert.equal(modal.props.open, true)
  assert.equal(nodes(modal, node => node.type?.name === 'ImagePreview')[0].props.photo.id, 'two')
  button(modal, 'agentNextPhoto').props.onClick(); modal = modalOf(harness.render())
  assert.equal(button(modal, 'agentNextPhoto').props.disabled, true)
  button(modal, 'agentNextPhoto').props.onClick(); modal = modalOf(harness.render())
  assert.equal(nodes(modal, node => node.type?.name === 'ImagePreview')[0].props.photo.id, 'three')
  let prevented = 0
  const key = extra => ({ key: 'ArrowLeft', preventDefault() { prevented++ }, stopPropagation() {}, ...extra })
  modal.props.onKeyDownCapture(key({ target: { closest: () => ({}) } }))
  assert.equal(prevented, 0, 'Editing fields retain their arrow keys')
  modal.props.onKeyDownCapture(key({})); modal = modalOf(harness.render())
  assert.equal(prevented, 1)
  assert.equal(nodes(modal, node => node.type?.name === 'ImagePreview')[0].props.photo.id, 'two')
  modal.props.onClose(); assert.equal(modalOf(harness.render()).props.open, false)
})

test('recorded Session results retain the horizontal card presentation and compact modal information', t => {
  const originalDocument = globalThis.document
  globalThis.document = { baseURI: 'https://profile.test/' }
  t.after(() => { globalThis.document = originalDocument })
  const recording = JSON.parse(readFileSync(new URL('./fixtures/session-search.expected.json', import.meta.url), 'utf8'))
  const UI = Object.fromEntries(['DisclosureRow', 'Modal', 'Button', 'Tag', 'Tooltip'].map(key => [key, Symbol(key)]))
  const projection = []
  recording.results.forEach((entry, index) => {
    const toolName = recording.calls[index].name
    if (!['afp_photo_search_start', 'afp_photo_details', 'afp_collection_items'].includes(toolName)) return
    let expanded = false
    const harness = cardHarness({ phase: 'result', block: entry.message, toolName, useDisclosure: () => ({ expanded, toggle() { expanded = !expanded } }) }, UI)
    let tree = harness.render()
    if (entry.message.isError) {
      const header = nodes(tree, node => node.type === UI.DisclosureRow)[0]
      projection.push({ tool: toolName, title: header.props.title, state: conversationPhotoModel({ phase: 'result', block: entry.message }).state,
        message: nodes(header.props.collapsedContent, node => node.props?.role === 'alert')[0].props.children[0],
        contentClass: header.props.contentClassName, layoutClass: header.props.contentLayoutClassName })
      return
    }
    const collapsedCards = nodes(tree, node => node.type === 'article').length
    nodes(tree, node => node.type === UI.DisclosureRow)[0].props.onToggle(); tree = harness.render()
    const strip = nodes(tree, node => node.props?.className === 'afp-chat-photo-strip')[0]
    nodes(tree, node => node.type?.name === 'ImagePreview')[0].props.open(); tree = harness.render()
    const modal = nodes(tree, node => node.type === UI.Modal)[0]
    projection.push({ tool: toolName, title: nodes(tree, node => node.type === UI.DisclosureRow)[0].props.title,
      contentClass: nodes(tree, node => node.type === UI.DisclosureRow)[0].props.contentClassName,
      layout: strip.props.className, collapsedCards, cards: nodes(tree, node => node.type === 'article').length,
      browsing: nodes(tree, node => node.type === UI.Button && ['agentPreviousPhotos', 'agentNextPhotos'].includes(node.props['aria-label'])).map(node => node.props['aria-label']),
      modal: { identifiersCollapsed: nodes(modal, node => node.type === 'details')[0].props.open !== true,
        footerLink: nodes(modal.props.footer, node => node.type === 'a')[0].props.children[0],
        navigation: nodes(modal, node => node.type === UI.Button).map(node => node.props['aria-label']) } })
  })
  assert.deepEqual(projection, JSON.parse(readFileSync(new URL('./fixtures/conversation-layout.expected.json', import.meta.url), 'utf8')))
})

test('keyed toolview registrations wait for the slot and are independent of workbench tab flags', () => {
  const pending = [], registrations = [], Component = () => null
  registerAfpConversationPhotos({ slots: { inject(name, factory) { pending.push({ name, factory }) },
    register(metadata, component) { registrations.push({ metadata, component }); return () => {} } } }, Component, 'afpWorkbench')
  assert.equal(registrations.length, 0)
  assert.equal(pending[0].name, 'tool.call.toolview')
  const disposers = [...pending[0].factory()]
  assert.equal(disposers.length, 5)
  assert.deepEqual(registrations.map(entry => entry.metadata.key), ['afp_photo_search_start', 'afp_photo_search', 'afp_photo_details', 'afp_collection_items', 'afp_result_page'])
  assert.ok(registrations.every(entry => entry.metadata.locale === 'afpWorkbench' && entry.component === Component))
})

const repo = new URL('../../../../', import.meta.url)
test('actual Cordis SlotRegistry waits for declarations and removes AFP cards on plugin disposal',
  { skip: !existsSync(new URL('packages/client/ui-renderer/src/client/registry.ts', repo)) }, () => {
    const script = `
      import { Context } from '@deepseek-ai/cordis';
      import { SlotRegistry } from './packages/client/ui-renderer/src/client/registry.ts';
      import { registerAfpConversationPhotos } from './custom-plugins/workspace/dsh-plugin-afp/src/client/afp-conversation-photos.js';
      const ctx = new Context();
      new SlotRegistry(ctx);
      const plugin = await ctx.plugin({name:'afp-card-fixture', inject:['slots'], apply(child) {
        registerAfpConversationPhotos(child, () => null, 'afpWorkbench');
      }});
      if (ctx.slots.entries('tool.call.toolview').length !== 0) throw new Error('Registered before declaration');
      const remove = ctx.slots.register({name:'root', children:{'tool.call.toolview':{kind:'keyed',scope:'session'}}}, () => null);
      console.log(JSON.stringify(ctx.slots.entries('tool.call.toolview').map(entry => entry.options.key)));
      await plugin.dispose();
      if (ctx.slots.entries('tool.call.toolview').length !== 0) throw new Error('Cards survived plugin disposal');
      await remove();
      await ctx.fiber.dispose();
    `
    const child = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module'],
      { cwd: fileURLToPath(repo), input: script, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(JSON.parse(child.stdout.trim()), ['afp_photo_search_start', 'afp_photo_search', 'afp_photo_details', 'afp_collection_items', 'afp_result_page'])
  })
